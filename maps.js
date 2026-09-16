/* ============================================================================
   SPACE PARTY — maps.js (shared by the server and the client)
   Five ships. Rooms + hallways form the walkable area; hallways overlap rooms
   by ~40px so doorways are passable. Tasks and vents are generated per room.
   Works as a Node module (require) and as a browser global (SpacePartyMaps).
   ============================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpacePartyMaps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PLAYER_RADIUS = 8;

  const TASK_TYPES = ['wires', 'card_swipe', 'button_hold', 'sequence'];

  // R(name,x,y,w,h) room; H(x,y,w,h) hallway (unnamed on the floor)
  const R = (name, x, y, w, h) => ({ name, x, y, w, h });
  const H = (x, y, w, h, tag = 'Hall') => ({ name: tag, x, y, w, h });

  const MAPS = {
    skeld: {
      id: 'skeld', name: 'The Skeld', width: 3200, height: 1800, spawn: { x: 1720, y: 520 }, emergency: { x: 1720, y: 420 },
      rooms: [
        R('Reactor', 80, 720, 380, 520), R('Upper Engine', 520, 260, 420, 340), R('Lower Engine', 520, 1380, 420, 340), R('Security', 520, 800, 280, 300),
        R('MedBay', 1000, 360, 360, 340), R('Electrical', 1000, 1000, 340, 340), R('Cafeteria', 1400, 160, 640, 520), R('Weapons', 2140, 200, 400, 340),
        R('O2', 2000, 780, 300, 260), R('Navigation', 2760, 700, 340, 380), R('Admin', 1900, 1080, 340, 260), R('Storage', 1420, 1240, 460, 480),
        R('Communications', 1900, 1440, 340, 260), R('Shields', 2400, 1240, 360, 300),
      ],
      halls: [H(420, 400, 140, 1200), H(900, 380, 540, 110), H(2000, 300, 180, 110), H(1660, 640, 120, 640), H(1740, 1140, 200, 110), H(1760, 840, 280, 100), H(2300, 500, 120, 780), H(2380, 840, 420, 110), H(1840, 1520, 620, 110), H(900, 1460, 560, 110), H(1120, 1300, 110, 200), H(1120, 660, 110, 380)],
      tasks: { Reactor: ['Start reactor', 'Unlock manifolds'], 'Upper Engine': ['Fuel engine', 'Align engine output'], 'Lower Engine': ['Fuel engine', 'Align engine output'], Security: ['Fix wiring'], MedBay: ['Submit scan', 'Inspect sample'], Electrical: ['Fix wiring', 'Divert power', 'Calibrate distributor'], Cafeteria: ['Empty garbage', 'Download data'], Weapons: ['Clear asteroids', 'Fix wiring'], O2: ['Clean O2 filter', 'Empty chute'], Navigation: ['Chart course', 'Stabilize steering'], Admin: ['Swipe card', 'Fix wiring'], Storage: ['Fix wiring', 'Fill canisters'], Communications: ['Upload data', 'Fix wiring'], Shields: ['Prime shields', 'Swipe card'] },
      ventGroups: [['Reactor', 'Upper Engine', 'Lower Engine'], ['MedBay', 'Electrical', 'Security'], ['Cafeteria', 'Admin'], ['Weapons', 'Navigation', 'Shields']],
    },
    mira: {
      id: 'mira', name: 'Mira Station', width: 4200, height: 2400, spawn: { x: 2100, y: 1240 }, emergency: { x: 2100, y: 1140 },
      rooms: [
        R('Launchpad', 120, 1700, 520, 560), R('Reactor', 120, 400, 520, 560), R('Laboratory', 900, 300, 620, 480), R('Decontamination', 900, 1000, 340, 260),
        R('Locker Room', 900, 1480, 520, 480), R('Cafeteria', 1740, 940, 760, 620), R('Balcony', 1740, 240, 760, 420), R('MedBay', 2760, 300, 500, 460),
        R('Greenhouse', 2760, 1000, 620, 560), R('Office', 3560, 300, 520, 460), R('Admin', 3560, 1000, 520, 400), R('Storage', 3560, 1700, 520, 560),
        R('Communications', 2760, 1800, 620, 460), R('Lounge', 1740, 1800, 760, 460),
      ],
      halls: [H(600, 640, 340, 110), H(600, 1900, 340, 110), H(1180, 1230, 600, 110), H(1380, 740, 110, 540), H(1380, 1230, 110, 500, 'Passage'), H(1380, 1720, 400, 120), H(2080, 620, 110, 360), H(2460, 1200, 340, 110), H(3340, 480, 260, 110), H(3340, 1200, 260, 110), H(3000, 720, 110, 320), H(3000, 1520, 110, 320), H(2460, 1960, 340, 110), H(3340, 1960, 260, 110), H(2100, 1520, 110, 320), H(3800, 720, 110, 320), H(3800, 1360, 110, 380)],
      tasks: { Launchpad: ['Fuel engines', 'Run diagnostics'], Reactor: ['Start reactor', 'Unlock manifolds'], Laboratory: ['Assemble artifact', 'Sort samples', 'Fix wiring'], Decontamination: ['Cycle airlock'], 'Locker Room': ['Fix wiring', 'Buy beverage'], Cafeteria: ['Empty garbage', 'Fix wiring'], Balcony: ['Measure weather', 'Clear asteroids'], MedBay: ['Submit scan', 'Inspect sample'], Greenhouse: ['Water plants', 'Clean O2 filter'], Office: ['Process data', 'Enter ID code'], Admin: ['Swipe card', 'Divert power'], Storage: ['Fix wiring', 'Chart course'], Communications: ['Upload data', 'Fix wiring'], Lounge: ['Empty chute', 'Buy beverage'] },
      ventGroups: [['Launchpad', 'Reactor', 'Laboratory'], ['Cafeteria', 'Balcony', 'Lounge'], ['MedBay', 'Greenhouse', 'Office'], ['Admin', 'Storage', 'Communications']],
    },
    polus: {
      id: 'polus', name: 'Polus Outpost', width: 4400, height: 2600, spawn: { x: 2200, y: 1200 }, emergency: { x: 2200, y: 1100 },
      rooms: [
        R('Dropship', 1800, 120, 800, 380), R('Electrical', 200, 300, 620, 520), R('O2', 200, 1100, 520, 460), R('Security', 1000, 900, 420, 420),
        R('Weapons', 1000, 300, 520, 400), R('Central Dome', 1800, 900, 800, 620), R('Laboratory', 3000, 300, 700, 560), R('Specimen Room', 3600, 1100, 640, 560),
        R('Communications', 3000, 1300, 500, 400), R('Storage', 1800, 1800, 800, 620), R('Admin', 3000, 1900, 620, 520), R('Boiler Room', 200, 1800, 800, 600),
        R('Office', 1000, 1800, 620, 520), R('Cooling Station', 3900, 300, 400, 500),
      ],
      halls: [H(2150, 460, 110, 480), H(780, 500, 260, 110), H(1480, 420, 360, 110, 'Walkway'), H(1400, 1080, 440, 110), H(680, 1280, 360, 110), H(2560, 1180, 480, 110), H(3300, 820, 110, 520), H(2560, 2060, 480, 110), H(2150, 1480, 110, 360), H(1580, 2060, 260, 110), H(960, 2060, 80, 110), H(3460, 1480, 300, 110, 'Walkway'), H(3660, 720, 300, 110), H(3300, 1660, 110, 280), H(400, 1520, 110, 320), H(1180, 1280, 110, 560)],
      tasks: { Dropship: ['Chart course', 'Insert keys'], Electrical: ['Fix wiring', 'Reboot wifi', 'Divert power'], O2: ['Clean O2 filter', 'Fill canisters'], Security: ['Fix wiring', 'Monitor tree'], Weapons: ['Clear asteroids', 'Store artifacts'], 'Central Dome': ['Scan boarding pass', 'Fix wiring'], Laboratory: ['Record temperature', 'Repair drill', 'Align telescope'], 'Specimen Room': ['Start reactor', 'Unlock manifolds'], Communications: ['Upload data', 'Reboot wifi'], Storage: ['Empty garbage', 'Fix wiring'], Admin: ['Swipe card', 'Empty chute'], 'Boiler Room': ['Open waterways', 'Replace water jug'], Office: ['Process data', 'Swipe card'], 'Cooling Station': ['Record temperature', 'Fix wiring'] },
      ventGroups: [['Electrical', 'O2', 'Boiler Room'], ['Security', 'Weapons', 'Office'], ['Central Dome', 'Storage', 'Admin'], ['Laboratory', 'Specimen Room', 'Communications']],
    },
    airship: {
      id: 'airship', name: 'The Airship', width: 5000, height: 2800, spawn: { x: 2500, y: 1250 }, emergency: { x: 2500, y: 1150 },
      rooms: [
        R('Cockpit', 120, 900, 520, 520), R('Armory', 900, 300, 520, 400), R('Vault', 900, 1700, 520, 460), R('Kitchen', 1700, 300, 560, 480),
        R('Viewing Deck', 1700, 1800, 640, 520), R('Meeting Room', 2200, 900, 620, 600), R('Engine Room', 3100, 300, 700, 520), R('Gap Room', 3100, 1000, 500, 460),
        R('Records', 3100, 1800, 560, 520), R('Electrical', 3900, 300, 700, 560), R('Cargo Bay', 3900, 1100, 900, 620), R('Showers', 3900, 2000, 600, 560),
        R('Main Hall', 1700, 900, 500, 600), R('Lounge', 2500, 2000, 640, 520), R('Medical', 120, 1700, 620, 520), R('Brig', 120, 300, 620, 480),
      ],
      halls: [H(600, 1100, 340, 110), H(600, 460, 340, 110), H(1380, 460, 360, 110), H(1380, 1900, 360, 110), H(600, 1900, 340, 110), H(1140, 660, 110, 1080, 'Ladder'), H(2160, 1150, 80, 110), H(1960, 740, 110, 200), H(1960, 1460, 110, 380), H(2780, 1150, 360, 110), H(2500, 1460, 110, 580), H(3340, 780, 110, 260), H(3340, 1420, 110, 420), H(3760, 500, 180, 110), H(3560, 1250, 380, 110), H(3620, 2060, 320, 110), H(2820, 2200, 320, 110), H(4200, 820, 110, 320), H(4200, 1680, 110, 360), H(380, 740, 110, 200), H(380, 1380, 110, 360)],
      tasks: { Cockpit: ['Stabilize steering', 'Chart course'], Armory: ['Fix wiring', 'Polish ruby'], Vault: ['Dress mannequin', 'Sort records'], Kitchen: ['Empty garbage', 'Rewind tapes'], 'Viewing Deck': ['Reset breakers', 'Fix wiring'], 'Meeting Room': ['Enter ID code', 'Download data'], 'Engine Room': ['Fuel engine', 'Start fans'], 'Gap Room': ['Fix wiring', 'Develop photos'], Records: ['Sort records', 'Upload data'], Electrical: ['Reset breakers', 'Fix wiring', 'Calibrate distributor'], 'Cargo Bay': ['Unlock safe', 'Fix wiring'], Showers: ['Fix shower', 'Empty garbage'], 'Main Hall': ['Decontaminate', 'Swipe card'], Lounge: ['Clean toilet', 'Empty chute'], Medical: ['Submit scan', 'Inspect sample'], Brig: ['Fix wiring', 'Divert power'] },
      ventGroups: [['Cockpit', 'Brig', 'Medical'], ['Armory', 'Vault', 'Kitchen'], ['Meeting Room', 'Main Hall', 'Lounge'], ['Engine Room', 'Gap Room', 'Records'], ['Electrical', 'Cargo Bay', 'Showers']],
    },
    fungle: {
      id: 'fungle', name: 'Fungle Colony', width: 4600, height: 2800, spawn: { x: 2300, y: 1300 }, emergency: { x: 2300, y: 1200 },
      rooms: [
        R('Dropship', 1900, 120, 800, 380), R('Beach', 200, 200, 900, 640), R('Kitchen', 1300, 400, 500, 440), R('Cafeteria', 1900, 900, 800, 640),
        R('Lookout', 3000, 200, 620, 560), R('Greenhouse', 3800, 300, 620, 620), R('Laboratory', 3000, 1000, 620, 560), R('Reactor', 3800, 1200, 620, 640),
        R('Communications', 3000, 1800, 620, 560), R('Storage', 1900, 1900, 800, 640), R('Jungle', 1000, 1300, 700, 700), R('Mining Pit', 200, 1200, 620, 640),
        R('Sleeping Quarters', 200, 2100, 900, 560), R('Campfire', 1300, 2200, 500, 440),
      ],
      halls: [H(2250, 460, 110, 480), H(1060, 460, 280, 110, 'Path'), H(1760, 580, 180, 110, 'Path'), H(1500, 800, 110, 540, 'Path'), H(1660, 1500, 280, 110, 'Path'), H(2660, 1200, 380, 110, 'Path'), H(3300, 720, 110, 320, 'Path'), H(3580, 480, 260, 110, 'Path'), H(3580, 1400, 260, 110, 'Path'), H(3300, 1520, 110, 320, 'Path'), H(2660, 2060, 380, 110, 'Path'), H(2250, 1500, 110, 440, 'Path'), H(780, 1500, 260, 110, 'Path'), H(500, 1800, 110, 340, 'Path'), H(1060, 2360, 280, 110, 'Path'), H(1660, 2360, 280, 110, 'Path'), H(1340, 1960, 110, 280, 'Path')],
      tasks: { Dropship: ['Chart course', 'Fix wiring'], Beach: ['Catch fish', 'Collect shells'], Kitchen: ['Roast marshmallow', 'Empty garbage'], Cafeteria: ['Fix wiring', 'Download data'], Lookout: ['Extract fuel', 'Align telescope'], Greenhouse: ['Water plants', 'Tune radio'], Laboratory: ['Test frisbee', 'Inspect sample'], Reactor: ['Start reactor', 'Unlock manifolds'], Communications: ['Tune radio', 'Upload data'], Storage: ['Fix wiring', 'Fill canisters'], Jungle: ['Collect samples', 'Mine ore'], 'Mining Pit': ['Mine ore', 'Fix wiring'], 'Sleeping Quarters': ['Build sandcastle', 'Fix wiring'], Campfire: ['Roast marshmallow', 'Collect vegetables'] },
      ventGroups: [['Beach', 'Kitchen', 'Mining Pit'], ['Cafeteria', 'Storage', 'Jungle'], ['Lookout', 'Laboratory', 'Communications'], ['Greenhouse', 'Reactor', 'Sleeping Quarters']],
    },
  };
  const MAP_LIST = Object.values(MAPS).map(m => ({ id: m.id, name: m.name, size: `${m.width}×${m.height}` }));

  function overlapRect(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    if (x2 - x1 <= 16 || y2 - y1 <= 16) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  function buildGates(def) {
    const gates = [];
    const seen = new Set();
    let n = 0;
    for (const room of def.rooms) {
      for (const hall of def.halls) {
        const o = overlapRect(room, hall);
        if (!o) continue;
        // Door slab is placed across the narrow dimension of the overlap.
        const vertical = o.w <= o.h;
        const w = vertical ? Math.min(20, o.w) : Math.max(42, Math.min(o.w - 8, 100));
        const h = vertical ? Math.max(42, Math.min(o.h - 8, 100)) : Math.min(20, o.h);
        const x = o.x + o.w / 2 - w / 2;
        const y = o.y + o.h / 2 - h / 2;
        const key = `${Math.round(x/10)}:${Math.round(y/10)}:${vertical?'v':'h'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        gates.push({
          id: `gate_${def.id}_${n++}`,
          room: room.name,
          x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
          orientation: vertical ? 'vertical' : 'horizontal',
          label: `${room.name} Gate`,
        });
      }
    }
    // Too many doors makes a large map frustrating. Keep a distributed set.
    if (gates.length <= 14) return gates;
    const step = gates.length / 14;
    return Array.from({ length: 14 }, (_, i) => gates[Math.floor(i * step)]);
  }

  function buildWeaponStations(def) {
    const preferred = ['Weapons', 'Armory', 'Security', 'Brig', 'Storage'];
    const picked = [];
    for (const name of preferred) {
      const r = def.rooms.find(x => x.name === name);
      if (r && !picked.includes(r)) picked.push(r);
      if (picked.length >= 3) break;
    }
    if (!picked.length) picked.push(def.rooms[Math.min(1, def.rooms.length - 1)]);
    return picked.map((r, i) => ({
      id: `weapon_${def.id}_${i}`,
      room: r.name,
      x: Math.round(r.x + r.w * (i % 2 ? .68 : .32)),
      y: Math.round(r.y + r.h * .58),
      type: 'pulse',
      label: 'Pulse Blaster Rack',
    }));
  }

  function buildMap(id) {
    const def = MAPS[id] || MAPS.skeld;
    const rooms = def.rooms, halls = def.halls;
    const walkable = rooms.concat(halls);
    const taskSpots = [];
    let typeIdx = 0;
    for (const r of rooms) {
      const names = def.tasks[r.name] || ['Fix wiring'];
      names.forEach((name, k) => {
        const spotsPerRoom = names.length;
        const fx = r.x + r.w * (0.22 + 0.56 * (spotsPerRoom === 1 ? .5 : k / (spotsPerRoom - 1)));
        const fy = r.y + (k % 2 === 0 ? r.h * .28 : r.h * .72);
        const type = /wir/i.test(name) ? 'wires' : /swipe|card|pass|id code|keys/i.test(name) ? 'card_swipe' : /fuel|hold|scan|download|upload|garbage|fill|water|roast|charge|empty|extract|mine/i.test(name) ? 'button_hold' : TASK_TYPES[(typeIdx++) % 4];
        taskSpots.push({ id: `${def.id}_${r.name.replace(/\s+/g, '_').toLowerCase()}_${k}`, room: r.name, x: Math.round(fx), y: Math.round(fy), type, name });
      });
    }
    const vents = [];
    def.ventGroups.forEach((group, g) => {
      const ids = group.map((rn, k) => `v_${g}_${k}`);
      group.forEach((rn, k) => {
        const r = rooms.find(x => x.name === rn);
        if (!r) return;
        vents.push({ id: ids[k], room: rn, x: Math.round(r.x + r.w * (k % 2 ? .78 : .2)), y: Math.round(r.y + r.h * .8), connections: ids.filter(x => x !== ids[k]) });
      });
    });
    const gates = buildGates(def);
    const weaponStations = buildWeaponStations(def);
    const theme = def.id === 'polus' ? 'ice' : def.id === 'fungle' ? 'jungle' : def.id === 'mira' ? 'station' : def.id === 'airship' ? 'industrial' : 'space';
    return {
      id: def.id, name: def.name, theme, width: def.width, height: def.height, spawn: def.spawn,
      rooms: walkable, collisionRects: [], taskLocations: taskSpots.map(t => ({ id: t.id, x: t.x, y: t.y })),
      vents, gates, weaponStations, emergencyButton: def.emergency,
      _taskSpots: taskSpots, _walkable: walkable, _namedRooms: rooms,
    };
  }


  /* ------------------------------------------------------------------------
     Navigation / collision over the walkable rectangles
     ------------------------------------------------------------------------ */
  function buildNav(walkable) {
    const n = walkable.length;
    const adj = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = walkable[i], b = walkable[j];
        const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
        const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
        if (x2 - x1 > 16 && y2 - y1 > 16) {
          const portal = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
          adj[i].push({ to: j, portal });
          adj[j].push({ to: i, portal });
        }
      }
    }
    const inside = (r, p, m = 0) => p.x >= r.x + m && p.x <= r.x + r.w - m && p.y >= r.y + m && p.y <= r.y + r.h - m;
    const rectsAt = p => { const out = []; for (let i = 0; i < n; i++) if (inside(walkable[i], p)) out.push(i); return out; };
    const walkableAt = (p, m = PLAYER_RADIUS) => { for (let i = 0; i < n; i++) if (inside(walkable[i], p, m)) return true; return false; };
    function path(from, to) {
      const starts = rectsAt(from);
      const goals = new Set(rectsAt(to));
      if (!starts.length || !goals.size) return [to];
      if (starts.some(s => goals.has(s))) return [to];
      const prev = new Map();
      const queue = starts.slice();
      starts.forEach(s => prev.set(s, { from: -1, portal: null }));
      let found = -1;
      while (queue.length) {
        const cur = queue.shift();
        if (goals.has(cur)) { found = cur; break; }
        for (const e of adj[cur]) { if (prev.has(e.to)) continue; prev.set(e.to, { from: cur, portal: e.portal }); queue.push(e.to); }
      }
      if (found < 0) return [to];
      const pts = [];
      let cur = found;
      while (cur >= 0) { const p = prev.get(cur); if (p.portal) pts.push(p.portal); cur = p.from; }
      pts.reverse();
      pts.push(to);
      return pts;
    }
    return { path, walkableAt, rectsAt };
  }

  return { MAPS, MAP_LIST, buildMap, buildNav, PLAYER_RADIUS };
});
