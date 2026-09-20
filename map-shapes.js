/*
 * Shared shape/rendering definitions for Egg Assault's Map Studio and the
 * game itself. Both map-studio.html (the editor) and index.html (the game)
 * load this file with a plain <script src="map-shapes.js"></script> tag and
 * call into it the same way, so a piece always looks the same in the editor
 * preview as it does in the real match. Keeping this in one place means a
 * shape only has to be taught how to draw itself once.
 *
 * This file is deliberately framework-light: every function takes the
 * caller's own THREE reference as its first argument instead of importing
 * one itself, since the two pages load different versions of three.js
 * (the editor uses the r128 global build, the game uses the r179 ES module
 * build). Passing THREE in keeps this file usable from either.
 */
(function (global) {
  "use strict";

  // ---- map size presets --------------------------------------------------
  // `half` is the distance from the map's center to its boundary walls.
  // "medium" matches the numbers the game already used before maps had a
  // size at all, so old submissions (and the built-in maps) are unaffected.
  var MAP_SIZES = {
    small: { id: "small", label: "Small", half: 34 },
    medium: { id: "medium", label: "Medium", half: 58 },
    large: { id: "large", label: "Large", half: 85 }
  };
  function mapSizeById(id) {
    return MAP_SIZES[id] || MAP_SIZES.medium;
  }

  // ---- piece catalog ------------------------------------------------------
  // `radial` pieces (barrel/sphere/cone) use w as a diameter and don't get an
  // independent depth control. `uniform` (sphere) also locks height to w.
  // Upper bounds here are deliberately generous (well past any built-in map's size) rather
  // than a "real" limit -- players asked to be able to make pieces any size they like, and an
  // HTML range input needs *some* max to stay usable, so this is effectively unlimited in
  // practice while still keeping the slider draggable.
  var SHAPE_DEFS = [
    { type: "wall", label: "Wall", w: 6, d: 1, h: 4, ranges: { w: [2, 300, 0.5], d: [0.5, 300, 0.5], h: [2, 300, 0.5] } },
    { type: "halfwall", label: "Low Wall", w: 6, d: 1, h: 1.6, ranges: { w: [2, 300, 0.5], d: [0.5, 300, 0.5], h: [1, 300, 0.2] } },
    { type: "crate", label: "Crate", w: 2, d: 2, h: 2, ranges: { w: [1, 300, 0.5], d: [1, 300, 0.5], h: [1, 300, 0.5] } },
    { type: "pillar", label: "Pillar", w: 1.6, d: 1.6, h: 5, ranges: { w: [1, 300, 0.2], d: [1, 300, 0.2], h: [2, 300, 0.5] } },
    { type: "platform", label: "Platform", w: 8, d: 8, h: 2.6, ranges: { w: [3, 300, 0.5], d: [3, 300, 0.5], h: [1, 300, 0.5] } },
    { type: "ramp", label: "Ramp", w: 2.6, d: 4, h: 2.6, ranges: { w: [1.5, 300, 0.5], d: [2, 300, 0.5], h: [1, 300, 0.5] } },
    { type: "stairs", label: "Stairs", w: 2.4, d: 6, h: 3, ranges: { w: [1.6, 300, 0.2], d: [2, 300, 0.5], h: [1, 300, 0.5] } },
    { type: "arch", label: "Archway", w: 6, d: 1.2, h: 4.5, ranges: { w: [4, 300, 0.5], d: [0.8, 300, 0.2], h: [3, 300, 0.5] } },
    { type: "barrel", label: "Barrel", w: 1.8, d: 1.8, h: 2.2, radial: true, ranges: { w: [0.8, 300, 0.2], h: [1, 300, 0.5] } },
    { type: "sphere", label: "Sphere", w: 1.6, d: 1.6, h: 1.6, radial: true, uniform: true, ranges: { w: [0.6, 300, 0.2] } },
    { type: "cone", label: "Cone", w: 1.6, d: 1.6, h: 2.2, radial: true, ranges: { w: [0.6, 300, 0.2], h: [1, 300, 0.5] } }
  ];
  function shapeDef(type) {
    for (var i = 0; i < SHAPE_DEFS.length; i++) if (SHAPE_DEFS[i].type === type) return SHAPE_DEFS[i];
    return SHAPE_DEFS[0];
  }

  var STAIR_STEPS = 6;
  var ARCH_OPENING_RATIO = 0.42; // fraction of an archway's width that's the walk-through gap
  var ARCH_OPENING_HEIGHT_RATIO = 0.72; // fraction of an archway's height that's open below the lintel

  // ---- footprint helpers (used for collision boxes, not rendering) -------
  // A piece rotated 90 or 270 degrees swaps which way its w/d run in world
  // space. This mirrors the same approximation the game already used for
  // walls/crates/pillars/platforms, now shared so every shape agrees on it.
  function footprintWD(o) {
    if (o.type === "barrel" || o.type === "sphere" || o.type === "cone") return { w: o.w, d: o.w };
    var steps = Math.round((o.rot || 0) / 90);
    var odd = (((steps % 2) + 2) % 2) === 1;
    return odd ? { w: o.d, d: o.w } : { w: o.w, d: o.d };
  }

  // World-space step rectangles for a 'stairs' piece, each {minX,maxX,minZ,maxZ,top}.
  // Matches the exact low/high convention already verified for ramps: at
  // rot=0 a piece rises toward +Z, rot=90 toward +X, rot=180 toward -Z,
  // rot=270 toward -X.
  function stairsSteps(o) {
    var steps = STAIR_STEPS;
    var w = o.w, d = o.d, h = o.h;
    var stepH = h / steps, stepD = d / steps;
    var rot = (((Math.round((o.rot || 0) / 90) % 4) + 4) % 4);
    var list = [];
    for (var i = 0; i < steps; i++) {
      var top = stepH * (i + 1);
      var rect;
      if (rot === 0) {
        var z0 = o.z - d / 2 + stepD * (i + 0.5);
        rect = { minX: o.x - w / 2, maxX: o.x + w / 2, minZ: z0 - stepD / 2, maxZ: z0 + stepD / 2 };
      } else if (rot === 2) {
        var z2 = o.z + d / 2 - stepD * (i + 0.5);
        rect = { minX: o.x - w / 2, maxX: o.x + w / 2, minZ: z2 - stepD / 2, maxZ: z2 + stepD / 2 };
      } else if (rot === 1) {
        var x1 = o.x - d / 2 + stepD * (i + 0.5);
        rect = { minX: x1 - stepD / 2, maxX: x1 + stepD / 2, minZ: o.z - w / 2, maxZ: o.z + w / 2 };
      } else {
        var x3 = o.x + d / 2 - stepD * (i + 0.5);
        rect = { minX: x3 - stepD / 2, maxX: x3 + stepD / 2, minZ: o.z - w / 2, maxZ: o.z + w / 2 };
      }
      rect.top = top;
      list.push(rect);
    }
    return list;
  }

  // The three collision boxes (post, post, lintel) for an 'arch' piece.
  // Posts are symmetric, so which one is "left" vs "right" never matters.
  function archParts(o) {
    var fw = footprintWD(o);
    var postW = Math.max(0.6, (o.w * (1 - ARCH_OPENING_RATIO)) / 2);
    var openH = o.h * ARCH_OPENING_HEIGHT_RATIO;
    var lintelH = o.h - openH;
    var halfSep = (fw.w - postW) / 2;
    var evenRot = (((Math.round((o.rot || 0) / 90) % 2) + 2) % 2) === 0;
    var postA, postB;
    if (evenRot) {
      postA = { minX: o.x - halfSep - postW / 2, maxX: o.x - halfSep + postW / 2, minZ: o.z - fw.d / 2, maxZ: o.z + fw.d / 2 };
      postB = { minX: o.x + halfSep - postW / 2, maxX: o.x + halfSep + postW / 2, minZ: o.z - fw.d / 2, maxZ: o.z + fw.d / 2 };
    } else {
      postA = { minX: o.x - fw.d / 2, maxX: o.x + fw.d / 2, minZ: o.z - halfSep - postW / 2, maxZ: o.z - halfSep + postW / 2 };
      postB = { minX: o.x - fw.d / 2, maxX: o.x + fw.d / 2, minZ: o.z + halfSep - postW / 2, maxZ: o.z + halfSep + postW / 2 };
    }
    var lintel = { minX: o.x - fw.w / 2, maxX: o.x + fw.w / 2, minZ: o.z - fw.d / 2, maxZ: o.z + fw.d / 2, bottom: openH, top: o.h };
    return { postA: postA, postB: postB, lintel: lintel };
  }

  // ---- visuals --------------------------------------------------------------
  function hexNum(h) {
    if (typeof h === "number") return h;
    var n = parseInt(String(h || "").replace("#", ""), 16);
    return isFinite(n) ? n : 0xffffff;
  }

  var _texCache = {};
  function baseTexture(THREE, mode) {
    if (_texCache[mode]) return _texCache[mode];
    var cvs = document.createElement("canvas");
    cvs.width = 128;
    cvs.height = 128;
    var ctx = cvs.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 128, 128);
    if (mode === "planks") {
      ctx.strokeStyle = "rgba(0,0,0,0.28)";
      ctx.lineWidth = 3;
      for (var y = 0; y <= 128; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke(); }
      ctx.strokeStyle = "rgba(0,0,0,0.14)";
      ctx.lineWidth = 1;
      for (var x = 8; x < 128; x += 16) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 128); ctx.stroke(); }
      ctx.fillStyle = "rgba(0,0,0,0.32)";
      [[0, 0], [1, 0], [0, 1], [1, 1]].forEach(function (c) {
        var cx = c[0] * 128, cy = c[1] * 128;
        ctx.fillRect(cx - (c[0] ? 18 : 0), cy - (c[1] ? 4 : 0), 18, 4);
        ctx.fillRect(cx - (c[0] ? 4 : 0), cy - (c[1] ? 18 : 0), 4, 18);
      });
    } else if (mode === "boards") {
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
      ctx.lineWidth = 2;
      for (var xx = 0; xx <= 128; xx += 18) { ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, 128); ctx.stroke(); }
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1;
      for (var xx2 = 4; xx2 < 128; xx2 += 18) { ctx.beginPath(); ctx.moveTo(xx2, 0); ctx.lineTo(xx2, 128); ctx.stroke(); }
    } else if (mode === "metal") {
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
      ctx.lineWidth = 3;
      for (var yy = 0; yy <= 128; yy += 24) { ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(128, yy); ctx.stroke(); }
      ctx.fillStyle = "rgba(0,0,0,0.30)";
      for (var yy2 = 12; yy2 < 128; yy2 += 24) for (var xx3 = 8; xx3 < 128; xx3 += 24) { ctx.beginPath(); ctx.arc(xx3, yy2, 2.4, 0, Math.PI * 2); ctx.fill(); }
    } else if (mode === "deck") {
      ctx.strokeStyle = "rgba(0,0,0,0.20)";
      ctx.lineWidth = 2;
      for (var yb = 0; yb <= 128; yb += 14) { ctx.beginPath(); ctx.moveTo(0, yb); ctx.lineTo(128, yb); ctx.stroke(); }
    } else if (mode === "smooth") {
      var grad = ctx.createLinearGradient(0, 0, 128, 0);
      grad.addColorStop(0, "rgba(0,0,0,0.10)");
      grad.addColorStop(0.5, "rgba(255,255,255,0.12)");
      grad.addColorStop(1, "rgba(0,0,0,0.10)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 128, 128);
    }
    var tex = new THREE.CanvasTexture(cvs);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    _texCache[mode] = tex;
    return tex;
  }
  function textureModeFor(type) {
    if (type === "crate" || type === "ramp" || type === "stairs") return "planks";
    if (type === "wall" || type === "halfwall" || type === "arch") return "boards";
    if (type === "pillar" || type === "barrel") return "metal";
    if (type === "platform") return "deck";
    if (type === "sphere" || type === "cone") return "smooth";
    return null;
  }
  function detailMaterial(THREE, colorHex, type, repeatX, repeatY) {
    var mode = textureModeFor(type);
    var tex = mode ? baseTexture(THREE, mode).clone() : null;
    if (tex) {
      tex.needsUpdate = true;
      tex.repeat.set(Math.max(1, Math.round(repeatX || 1)), Math.max(1, Math.round(repeatY || 1)));
    }
    return new THREE.MeshLambertMaterial({ color: hexNum(colorHex), map: tex || null });
  }

  function applyGlow(obj, THREE, colorNum, o) {
    if (!o.glow) return;
    obj.traverse(function (node) {
      if (node.isMesh && node.material && "emissive" in node.material) {
        node.material.emissive = new THREE.Color(colorNum);
        node.material.emissiveIntensity = 0.55;
      }
    });
    var reach = Math.max(o.w || 2, o.d || 2, o.h || 2) * 3.2 + 5;
    var light = new THREE.PointLight(colorNum, 2.4, reach);
    light.position.set(0, (o.h || 2) * 0.55, 0);
    obj.add(light);
  }

  // Builds and positions the full visual for a piece (already placed at
  // o.x/o.z and rotated by o.rot) — a Mesh for simple shapes, a Group for
  // compound ones (platform/arch/stairs). Collision is handled separately
  // by each caller using footprintWD/stairsSteps/archParts above, since the
  // two games' collision systems differ from how things are drawn.
  function buildShapeVisual(THREE, o, colorHex) {
    var colorNum = hexNum(colorHex);
    var w = o.w || 1, d = o.d || 1, h = o.h || 1;
    var obj;

    if (o.type === "sphere") {
      var rs = w / 2;
      obj = new THREE.Mesh(new THREE.SphereGeometry(rs, 18, 14), detailMaterial(THREE, colorHex, o.type, 1, 1));
      obj.position.set(o.x, rs, o.z);
    } else if (o.type === "barrel") {
      var rb = w / 2;
      obj = new THREE.Mesh(new THREE.CylinderGeometry(rb, rb, h, 18), detailMaterial(THREE, colorHex, o.type, 1, Math.max(1, h / 1.4)));
      obj.position.set(o.x, h / 2, o.z);
    } else if (o.type === "cone") {
      var rc = w / 2;
      obj = new THREE.Mesh(new THREE.ConeGeometry(rc, h, 18), detailMaterial(THREE, colorHex, o.type, 1, 1));
      obj.position.set(o.x, h / 2, o.z);
    } else if (o.type === "stairs") {
      obj = new THREE.Group();
      var mat = detailMaterial(THREE, colorHex, o.type, w / 1.5, 1);
      var steps = STAIR_STEPS, stepH = h / steps, stepD = d / steps;
      for (var i = 0; i < steps; i++) {
        var sm = new THREE.Mesh(new THREE.BoxGeometry(w, stepH, stepD), mat);
        sm.position.set(0, stepH * (i + 0.5), -d / 2 + stepD * (i + 0.5));
        obj.add(sm);
      }
      obj.position.set(o.x, 0, o.z);
    } else if (o.type === "arch") {
      obj = new THREE.Group();
      var mat2 = detailMaterial(THREE, colorHex, o.type, w / 2, h / 2);
      var postW = Math.max(0.6, (w * (1 - ARCH_OPENING_RATIO)) / 2);
      var openH = h * ARCH_OPENING_HEIGHT_RATIO;
      var lintelH = h - openH;
      var pl = new THREE.Mesh(new THREE.BoxGeometry(postW, h, d), mat2);
      pl.position.set(-(w - postW) / 2, h / 2, 0);
      obj.add(pl);
      var pr = new THREE.Mesh(new THREE.BoxGeometry(postW, h, d), mat2);
      pr.position.set((w - postW) / 2, h / 2, 0);
      obj.add(pr);
      var lt = new THREE.Mesh(new THREE.BoxGeometry(w, lintelH, d), mat2);
      lt.position.set(0, openH + lintelH / 2, 0);
      obj.add(lt);
      obj.position.set(o.x, 0, o.z);
    } else if (o.type === "platform") {
      obj = new THREE.Group();
      var deckMat = detailMaterial(THREE, colorHex, o.type, w / 1.4, d / 1.4);
      var post = new THREE.Mesh(new THREE.BoxGeometry(1.7, h, 1.7), deckMat);
      post.position.set(0, h / 2, 0);
      obj.add(post);
      var top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), deckMat);
      top.position.set(0, h - 0.14, 0);
      obj.add(top);
      var railH = 0.28;
      var railA = new THREE.Mesh(new THREE.BoxGeometry(w, railH, 0.12), deckMat);
      railA.position.set(0, h + railH / 2 - 0.02, d / 2 - 0.06);
      obj.add(railA);
      var railB = new THREE.Mesh(new THREE.BoxGeometry(w, railH, 0.12), deckMat);
      railB.position.set(0, h + railH / 2 - 0.02, -d / 2 + 0.06);
      obj.add(railB);
      obj.position.set(o.x, 0, o.z);
    } else if (o.type === "ramp") {
      var len = Math.sqrt(d * d + h * h);
      obj = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, len), detailMaterial(THREE, colorHex, o.type, w / 1.5, len / 1.5));
      obj.position.set(o.x, h / 2, o.z);
      obj.rotation.x = -Math.atan2(h, d);
    } else {
      // wall, halfwall, crate, pillar
      obj = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), detailMaterial(THREE, colorHex, o.type, w / 1.6, h / 1.6));
      obj.position.set(o.x, h / 2, o.z);
      if (o.type === "pillar") {
        var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffd35a }));
        bulb.position.set(0, h / 2 + 0.2, 0);
        obj.add(bulb);
      }
    }

    obj.rotation.y = ((o.rot || 0) * Math.PI) / 180;
    applyGlow(obj, THREE, colorNum, o);
    return obj;
  }

  global.EggMapShapes = {
    MAP_SIZES: MAP_SIZES,
    mapSizeById: mapSizeById,
    SHAPE_DEFS: SHAPE_DEFS,
    shapeDef: shapeDef,
    STAIR_STEPS: STAIR_STEPS,
    ARCH_OPENING_RATIO: ARCH_OPENING_RATIO,
    ARCH_OPENING_HEIGHT_RATIO: ARCH_OPENING_HEIGHT_RATIO,
    footprintWD: footprintWD,
    stairsSteps: stairsSteps,
    archParts: archParts,
    buildShapeVisual: buildShapeVisual,
    hexNum: hexNum
  };
})(window);
