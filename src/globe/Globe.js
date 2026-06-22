import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { latLngToXYZ, EARTH_RADIUS_KM } from '../utils/geo.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GLOBE_RADIUS = 1;

/** Scale node dot radius down with density. Capped at 0.007 (default size).
 *  At 5 000 nodes → 0.007.  At 50 000 nodes → ~0.0022.  Floor: 0.0018. */
function nodeRadius(n) {
  return Math.min(0.007, Math.max(0.0018, 0.007 * Math.sqrt(5000 / Math.max(1, n))));
}

const C = {
  ocean:      '#0a2040',
  land:       '#2a5580',
  border:     '#55aaff',
  // Light-mode globe colours
  oceanLight: '#88b8dd',
  landLight:  '#6aaa88',
  borderLight:'#3a6a50',
  atmosphere: 0x1a5090,
  nodeAlive:  0x00ff88,
  nodeDead:   0xff3333,
  // Node-click selection colours
  nodeSelected:    0xffff00,
  connLine:        0xff8800,   // orange connection lines
  connNodeHighlight: 0xffaa44, // tinted orange for connected nodes
  // Pub/Sub group highlights
  pubsubRelay:       0xffcc00, // gold   — relay node
  pubsubParticipant: 0xff44cc, // hot pink — subscriber nodes
};

// ─────────────────────────────────────────────────────────────────────────────
// LandMask
// ─────────────────────────────────────────────────────────────────────────────

class LandMask {
  constructor() {
    this.maskW    = 1440;
    this.maskH    = 720;
    this.maskData = null;
    this.texture  = null;
  }

  async build(geoJSON) {
    this._geoJSON = geoJSON;
    // Binary mask for isLand() queries
    const mask = document.createElement('canvas');
    mask.width = this.maskW; mask.height = this.maskH;
    const mCtx = mask.getContext('2d');
    mCtx.fillStyle = '#000'; mCtx.fillRect(0, 0, this.maskW, this.maskH);
    mCtx.fillStyle = '#fff'; this._fill(mCtx, geoJSON, this.maskW, this.maskH);
    this.maskData = mCtx.getImageData(0, 0, this.maskW, this.maskH).data;

    this._buildTexture(false);
  }

  _buildTexture(isLight) {
    const geoJSON = this._geoJSON;
    // Coloured canvas texture for the sphere
    const texW = 2048, texH = 1024;
    const tex = document.createElement('canvas');
    tex.width = texW; tex.height = texH;
    const tCtx = tex.getContext('2d');
    tCtx.fillStyle = isLight ? C.oceanLight : C.ocean;
    tCtx.fillRect(0, 0, texW, texH);
    tCtx.fillStyle = isLight ? C.landLight : C.land;
    this._fill(tCtx, geoJSON, texW, texH);
    tCtx.strokeStyle = isLight ? C.borderLight : C.border;
    tCtx.lineWidth = 0.8;
    this._stroke(tCtx, geoJSON, texW, texH);
    this.texture = new THREE.CanvasTexture(tex);
  }

  _fill(ctx, geoJSON, W, H) {
    for (const f of geoJSON.features) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates]
        : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) for (const ring of poly) this._fillRing(ctx, ring, W, H);
    }
  }

  _fillRing(ctx, ring, W, H) {
    if (ring.length < 3) return;

    // Unwrap longitudes so the ring is continuous — no ±180° jumps.
    // Each point is adjusted to be within 180° of the previous one.
    const pts = [];
    for (let i = 0; i < ring.length; i++) {
      let lng = ring[i][0], lat = ring[i][1];
      if (i > 0) {
        const pLng = pts[i - 1][0];
        while (lng - pLng >  180) lng -= 360;
        while (lng - pLng < -180) lng += 360;
      }
      pts.push([lng, lat]);
    }

    // Find the unwrapped extent so we know if the ring spills past either edge.
    let minLng = pts[0][0], maxLng = pts[0][0];
    for (const [lng] of pts) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }

    // Draw the ring at a given longitude shift; the canvas clips out-of-bounds pixels.
    const drawFill = (shift) => {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = ((pts[i][0] + shift + 180) / 360) * W;
        const y = ((90 - pts[i][1]) / 180) * H;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    };

    drawFill(0);
    if (maxLng >  180) drawFill(-360); // ring extends past the right edge → also fill shifted left
    if (minLng < -180) drawFill( 360); // ring extends past the left edge  → also fill shifted right
  }

  _stroke(ctx, geoJSON, W, H) {
    for (const f of geoJSON.features) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates]
        : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) for (const ring of poly) this._strokeRing(ctx, ring, W, H);
    }
  }

  _strokeRing(ctx, ring, W, H) {
    ctx.beginPath(); let started = false, pLng = null, pLat = null;
    for (const [lng, lat] of ring) {
      const x = ((lng + 180) / 360) * W, y = ((90 - lat) / 180) * H;
      if (started && pLng !== null && Math.abs(lng - pLng) > 180) {
        const adjLng = lng + (lng - pLng > 180 ? -360 : 360);
        const bndLng = adjLng < pLng ? -180 : 180;
        const tCross = (bndLng - pLng) / (adjLng - pLng);
        const bndLat = pLat + tCross * (lat - pLat);
        ctx.lineTo(((bndLng + 180) / 360) * W, ((90 - bndLat) / 180) * H);
        ctx.stroke(); ctx.beginPath();
        ctx.moveTo(((-bndLng + 180) / 360) * W, ((90 - bndLat) / 180) * H);
        started = true;
      }
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      pLng = lng; pLat = lat;
    }
    ctx.stroke();
  }

  isLand(lat, lng) {
    if (!this.maskData) return true;
    if (lat < -60) return false;          // exclude Antarctica
    const x = Math.floor(((lng + 180) / 360) * this.maskW) % this.maskW;
    const y = Math.floor(((90 - lat)  / 180) * this.maskH) % this.maskH;
    return this.maskData[(y * this.maskW + x) * 4] > 128;
  }

  randomLandPoint(tries = 500) {
    for (let i = 0; i < tries; i++) {
      const lat = Math.random() * 140 - 60; // −60° to +80°, no Antarctica
      const lng = Math.random() * 360 - 180;
      if (this.isLand(lat, lng)) return { lat, lng };
    }
    return { lat: 51.5, lng: -0.1 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Globe
// ─────────────────────────────────────────────────────────────────────────────

export class Globe {
  constructor(canvas) {
    this.canvas   = canvas;
    this.landMask = new LandMask();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x010810);

    this.scene  = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.position.set(0, 0, 2.6);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping   = true;
    this.controls.dampingFactor   = 0.06;
    this.controls.minDistance     = 1.1;
    this.controls.maxDistance     = 8;
    this.controls.autoRotate      = false;
    this.controls.autoRotateSpeed = 0.4;
    this.controls.enablePan       = false;  // prevent dragging globe off-centre

    this.globeGroup   = new THREE.Group();
    this.nodeGroup    = new THREE.Group();
    this.hitGroup     = new THREE.Group(); // invisible larger spheres for raycasting
    this.arcGroup     = new THREE.Group();
    this.connGroup    = new THREE.Group(); // routing-table connection lines
    this.scene.add(this.globeGroup, this.nodeGroup, this.hitGroup, this.arcGroup, this.connGroup);

    this._nodeObjects  = new Map();  // nodeId → THREE.Mesh (visual)
    this._hitObjects   = new Map();  // nodeId → THREE.Mesh (invisible hit target)
    this._nodeDataMap  = new Map();  // nodeId → { lat, lng, alive }
    this._globeMesh    = null;
    this._raycaster    = new THREE.Raycaster();
    this._selectedId   = null;
    this._animFrame    = null;
    this._pointerMoved = false; // distinguish click vs drag
    this._pubsubHighlighted = new Set(); // nodeIds currently pub/sub highlighted

    // Smooth camera pan state
    this._panStart    = new THREE.Vector3(0, 0, 1); // camera dir at pan start
    this._panTarget   = null;                        // target dir (unit vec), null = idle
    this._panDuration = 600;                         // ms
    this._panT        = 1;                           // progress 0→1

    this._buildBaseScene();
    this._setupRaycasting();
    window.addEventListener('resize', () => this._onResize());
    this._onResize();
    this._startRenderLoop();
  }

  // ── Base scene ────────────────────────────────────────────────────────────

  _buildBaseScene() {
    this._ambientLight = new THREE.AmbientLight(0x4466aa, 2.5);
    this.scene.add(this._ambientLight);
    this._sunLight = new THREE.DirectionalLight(0xffffff, 2.5);
    this._sunLight.position.set(5, 3, 5);
    this.scene.add(this._sunLight);

    // Stars
    const sp = new Float32Array(8000 * 3);
    for (let i = 0; i < sp.length; i++) sp[i] = (Math.random() - 0.5) * 90;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.scene.add(new THREE.Points(sg,
      new THREE.PointsMaterial({ color: 0xffffff, size: 0.04, transparent: true, opacity: 0.75 })));

    this._globeMesh = new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS, 64, 32),
      new THREE.MeshPhongMaterial({ color: 0x0a2040, specular: 0x1a3a60, shininess: 5 })
    );
    this.globeGroup.add(this._globeMesh);

    this.globeGroup.add(new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS * 1.025, 32, 16),
      new THREE.MeshPhongMaterial({
        color: C.atmosphere, transparent: true, opacity: 0.07, side: THREE.FrontSide,
      })
    ));
  }

  // ── Country texture ───────────────────────────────────────────────────────

  async loadCountries(geoJSON) {
    this._geoJSON = geoJSON;
    await this.landMask.build(geoJSON);
    this._globeMesh.material = new THREE.MeshPhongMaterial({
      map: this.landMask.texture, specular: 0x1a3a60, shininess: 4,
    });
    this._renderBorderLines(geoJSON, false);
  }

  _renderBorderLines(geoJSON, isLight) {
    // Remove old border lines if any
    if (this._borderGroup) {
      this.globeGroup.remove(this._borderGroup);
      this._borderGroup.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
    }
    this._borderGroup = new THREE.Group();
    this.globeGroup.add(this._borderGroup);

    const R   = GLOBE_RADIUS * 1.001;
    const borderColor = isLight ? 0x3a6a50 : 0x4499ee;
    const borderOpacity = isLight ? 0.5 : 0.4;
    const mat = new THREE.LineBasicMaterial({ color: borderColor, transparent: true, opacity: borderOpacity });
    for (const f of geoJSON.features) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates]
        : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) this._addBorderLine(poly[0], R, mat);
    }
  }

  _addBorderLine(ring, R, mat) {
    if (!ring || ring.length < 2) return;
    const segs = [[]]; let pLng = null, pLat = null;
    for (const [lng, lat] of ring) {
      if (pLng !== null && Math.abs(lng - pLng) > 180) {
        const adjLng = lng + (lng - pLng > 180 ? -360 : 360);
        const dLng = adjLng - pLng;
        if (Math.abs(dLng) > 1e-10) {
          const bndLng = adjLng < pLng ? -180 : 180;
          const tCross = (bndLng - pLng) / dLng;
          if (tCross >= 0 && tCross <= 1) {
            const bndLat = pLat + tCross * (lat - pLat);
            const pb = latLngToXYZ(bndLat, bndLng, R);
            segs[segs.length - 1].push(new THREE.Vector3(pb.x, pb.y, pb.z));
            segs.push([]);
            const pb2 = latLngToXYZ(bndLat, -bndLng, R);
            segs[segs.length - 1].push(new THREE.Vector3(pb2.x, pb2.y, pb2.z));
          } else {
            segs.push([]);
          }
        } else {
          segs.push([]);
        }
      }
      const { x, y, z } = latLngToXYZ(lat, lng, R);
      segs[segs.length - 1].push(new THREE.Vector3(x, y, z));
      pLng = lng; pLat = lat;
    }
    for (const seg of segs) {
      if (seg.length < 2) continue;
      (this._borderGroup || this.globeGroup).add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(seg), mat));
    }
  }

  // ── Land queries ──────────────────────────────────────────────────────────

  isLand(lat, lng)  { return this.landMask.isLand(lat, lng); }
  randomLandPoint() { return this.landMask.randomLandPoint(); }

  // ── Node rendering ────────────────────────────────────────────────────────

  /** Maximum nodes rendered with individual meshes.  Above this threshold
   *  we switch to InstancedMesh for performance (single draw call). */
  static INSTANCED_THRESHOLD = 10_000;

  setNodes(nodes) {
    // ── Tear down previous render objects ────────────────────────────────
    this._nodeObjects.forEach(m => this.nodeGroup.remove(m));
    this._hitObjects.forEach(m => this.hitGroup.remove(m));
    this._nodeObjects.clear();
    this._hitObjects.clear();
    this._nodeDataMap.clear();
    this.clearConnections();

    if (this._instancedMesh) {
      this.nodeGroup.remove(this._instancedMesh);
      this._instancedMesh.dispose();
      this._instancedMesh = null;
    }
    if (this._instancedHitMesh) {
      this.hitGroup.remove(this._instancedHitMesh);
      this._instancedHitMesh.dispose();
      this._instancedHitMesh = null;
    }
    this._instancedIndex = null;  // nodeId → instance index
    this._instancedReverse = null; // instance index → nodeId

    const r = nodeRadius(nodes.length);

    if (nodes.length > Globe.INSTANCED_THRESHOLD) {
      this._setNodesInstanced(nodes, r);
    } else {
      this._setNodesIndividual(nodes, r);
    }
  }

  /** Individual meshes — used for ≤INSTANCED_THRESHOLD nodes.
   *  Supports per-node color changes, click raycasting, etc. */
  _setNodesIndividual(nodes, r) {
    const visGeo = new THREE.SphereGeometry(r, 7, 7);
    // Invisible hit sphere: 4× larger for reliable clicking even when zoomed out
    const hitGeo = new THREE.SphereGeometry(r * 4, 5, 5);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });

    for (const n of nodes) {
      const col = n.alive ? C.nodeAlive : C.nodeDead;
      const { x, y, z } = latLngToXYZ(n.lat, n.lng, GLOBE_RADIUS * 1.009);

      // Visual node
      const visMat = new THREE.MeshPhongMaterial({ color: col, emissive: col, emissiveIntensity: 0.7 });
      const visMesh = new THREE.Mesh(visGeo, visMat);
      visMesh.position.set(x, y, z);
      this.nodeGroup.add(visMesh);
      this._nodeObjects.set(n.id, visMesh);

      // Invisible hit target
      const hitMesh = new THREE.Mesh(hitGeo, hitMat);
      hitMesh.position.set(x, y, z);
      hitMesh.userData.nodeId = n.id;
      this.hitGroup.add(hitMesh);
      this._hitObjects.set(n.id, hitMesh);

      this._nodeDataMap.set(n.id, { lat: n.lat, lng: n.lng, alive: n.alive });
    }
  }

  /** Instanced rendering — one draw call for all nodes.
   *  Used for >INSTANCED_THRESHOLD nodes.  Per-node colour via the
   *  InstancedMesh's `instanceColor` property (three.js binds that
   *  buffer to the shader's `attribute vec3 instanceColor;` when
   *  `mesh.instanceColor !== null`, enabling the USE_INSTANCING_COLOR
   *  define so `vColor.xyz *= instanceColor.xyz;` runs per-vertex).
   *  Click raycasting via a matching invisible hit InstancedMesh with
   *  4×-larger spheres (same strategy as the individual-mesh path). */
  _setNodesInstanced(nodes, r) {
    const geo = new THREE.SphereGeometry(r, 5, 5);

    // Material. `color` is white so the per-instance colour (applied via
    // `mesh.instanceColor` below, which triggers USE_INSTANCING_COLOR in
    // three.js's shader) fully determines the body hue. We use a LOW
    // emissive intensity with a white tint so the instance colour is
    // not washed out — this approximates the "yellow glow" of the
    // individual-mesh path while keeping the stock phong shader.
    const mat = new THREE.MeshPhongMaterial({
      color:             0xffffff,
      emissive:          0xffffff,
      emissiveIntensity: 0.15,
    });

    const count = nodes.length;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    // Allocate the per-instance colour buffer directly on the mesh.
    // Setting `mesh.instanceColor` (as opposed to a geometry attribute)
    // is what triggers USE_INSTANCING_COLOR in three.js's WebGLProgram
    // and binds the buffer to the shader's `instanceColor` attribute.
    const instColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    mesh.instanceColor = instColor;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const indexMap   = new Map();         // nodeId → instance index
    const reverseMap = new Array(count);  // instance index → nodeId

    for (let i = 0; i < count; i++) {
      const n = nodes[i];
      const { x, y, z } = latLngToXYZ(n.lat, n.lng, GLOBE_RADIUS * 1.009);

      dummy.position.set(x, y, z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      color.setHex(n.alive ? C.nodeAlive : C.nodeDead);
      instColor.setXYZ(i, color.r, color.g, color.b);

      indexMap.set(n.id, i);
      reverseMap[i] = n.id;
      this._nodeDataMap.set(n.id, { lat: n.lat, lng: n.lng, alive: n.alive });
    }

    instColor.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    this.nodeGroup.add(mesh);
    this._instancedMesh    = mesh;
    this._instancedIndex   = indexMap;
    this._instancedReverse = reverseMap;

    // ── Invisible hit mesh: 4×-larger spheres for reliable click picking ──
    // Raycasting against the tiny (r≈0.0018 at 50K nodes) visible spheres
    // misses most clicks, so we mirror the individual-mesh path and add
    // an invisible InstancedMesh with the same positions but a 4× radius.
    // Reuses the same indexMap / reverseMap so a hit's instanceId maps
    // directly back to a nodeId.
    const hitGeo = new THREE.SphereGeometry(r * 4, 5, 5);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    const hitMesh = new THREE.InstancedMesh(hitGeo, hitMat, count);
    hitMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    for (let i = 0; i < count; i++) {
      const n = nodes[i];
      const { x, y, z } = latLngToXYZ(n.lat, n.lng, GLOBE_RADIUS * 1.009);
      dummy.position.set(x, y, z);
      dummy.updateMatrix();
      hitMesh.setMatrixAt(i, dummy.matrix);
    }
    hitMesh.instanceMatrix.needsUpdate = true;
    this.hitGroup.add(hitMesh);
    this._instancedHitMesh = hitMesh;
  }

  /** Color nodes for a Slice World run.
   *
   * Yellow = Western hemisphere (lng < 0) with no cross-hem peer in its
   *          routing structures.
   * White  = Eastern hemisphere (lng >= 0) with no cross-hem peer.
   * Green  = Has at least one peer in the OPPOSITE hemisphere via its
   *          routing tables (synaptome / incomingSynapses for neuromorphic
   *          protocols, buckets / incomingPeers for Kademlia / G-DHT).
   *
   * Idempotent — safe to call repeatedly. Designed to be invoked once after
   * pruneSliceWorld establishes the partition (only the bridge node is green
   * at that moment), then periodically as routing progresses (learning
   * re-stitches the partition; nodes that gain a cross-hem peer turn green
   * to visualize the recovery dynamics).
   *
   * v0.68.01 — added for Slice World visual narrative.
   */
  setSliceWorldColors(dht, bridgeId) {
    if (!dht || !dht.nodeMap) return;
    const YELLOW = new THREE.Color(0xFFE040);
    const WHITE  = new THREE.Color(0xF5F5F5);
    const GREEN  = new THREE.Color(0x00DD66);
    const DEAD   = new THREE.Color(C.nodeDead);

    // First call sets the bridge id; subsequent refreshes (from the engine
    // progress callback) reuse it.
    if (bridgeId !== undefined) this._sliceBridgeId = bridgeId;
    const bid = this._sliceBridgeId;

    const nodeMap = dht.nodeMap;
    const nodes = (typeof dht.getNodes === 'function')
      ? dht.getNodes()
      : [...nodeMap.values()];

    // Walk routing-table peers, EXCLUDING the bridge node from the
    // cross-hemisphere test. The bridge is the only sanctioned cross-hem
    // peer; non-bridge nodes that simply happen to know the bridge aren't
    // "bridging" the partition themselves — they're just one routing hop
    // from the bridge. Only nodes that have a NON-bridge peer in the
    // opposite hemisphere have actually re-stitched the partition (which
    // initially is only Hawaii itself, and post-learning is wherever
    // hop-caching / triadic-closure / lateral-spread has deposited new
    // cross-hem synapses).
    const hasCrossHemPeer = (node) => {
      const nodeWest = node.lng < 0;
      const checkPeerId = (peerId) => {
        if (peerId === bid) return false;       // skip bridge
        const peer = nodeMap.get(peerId);
        if (!peer || !peer.alive) return false;
        return (peer.lng < 0) !== nodeWest;
      };
      const checkPeerObj = (peer) => {
        if (!peer || !peer.alive) return false;
        if (peer.id === bid) return false;      // skip bridge
        return (peer.lng < 0) !== nodeWest;
      };
      if (node.synaptome) {
        for (const peerId of node.synaptome.keys()) {
          if (checkPeerId(peerId)) return true;
        }
      }
      if (node.incomingSynapses) {
        for (const peerId of node.incomingSynapses.keys()) {
          if (checkPeerId(peerId)) return true;
        }
      }
      if (node.buckets) {
        for (const bucket of node.buckets) {
          for (const peer of bucket.nodes) {
            if (checkPeerObj(peer)) return true;
          }
        }
      }
      if (node.incomingPeers) {
        for (const [, peer] of node.incomingPeers) {
          if (checkPeerObj(peer)) return true;
        }
      }
      return false;
    };

    // Count NON-BRIDGE cross-hem peers per node so we can render a
    // gradient (yellow/white → green) instead of a binary flip. The
    // partition-dissolution dynamic is fast — within seconds of training,
    // every node has at least one cross-hem peer — so a binary check
    // saturates instantly. A gradient by count lets the visualization
    // show the wave of green spreading outward from the bridge.
    const countCrossHemPeers = (node) => {
      const nodeWest = node.lng < 0;
      let n = 0;
      const checkPeerId = (peerId) => {
        if (peerId === bid) return;
        const peer = nodeMap.get(peerId);
        if (!peer || !peer.alive) return;
        if ((peer.lng < 0) !== nodeWest) n++;
      };
      const checkPeerObj = (peer) => {
        if (!peer || !peer.alive) return;
        if (peer.id === bid) return;
        if ((peer.lng < 0) !== nodeWest) n++;
      };
      if (node.synaptome) for (const pid of node.synaptome.keys()) checkPeerId(pid);
      if (node.incomingSynapses) for (const pid of node.incomingSynapses.keys()) checkPeerId(pid);
      if (node.buckets) for (const b of node.buckets) for (const p of b.nodes) checkPeerObj(p);
      if (node.incomingPeers) for (const [, p] of node.incomingPeers) checkPeerObj(p);
      return n;
    };

    // Mix base (yellow / white) toward GREEN by a factor that saturates
    // around 5 cross-hem peers. count=0 → 100 % base. count=1 → ~33 %
    // green tint. count=5 → ~80 %. count≥10 → near-pure green.
    const tmp = new THREE.Color();
    const tintToGreen = (base, count) => {
      const t = 1 - Math.exp(-count / 3);    // 0 → 0, 1 → 0.28, 3 → 0.63, 5 → 0.81, 10 → 0.96
      tmp.copy(base).lerp(GREEN, t);
      return tmp;
    };

    const counts = { yellow: 0, white: 0, green: 0, dead: 0 };
    const colorFor = (node) => {
      if (!node.alive) { counts.dead++; return DEAD; }
      const nXh = countCrossHemPeers(node);
      const base = node.lng < 0 ? YELLOW : WHITE;
      if (nXh > 0) counts.green++;
      else if (node.lng < 0) counts.yellow++;
      else counts.white++;
      return tintToGreen(base, nXh);
    };

    // ── Instanced path — use the official InstancedMesh.setColorAt API.
    // setColorAt writes through the existing instanceColor attribute and
    // is the path that reliably triggers the per-instance USE_INSTANCING_COLOR
    // shader define on every supported three.js version. The lower-level
    // attr.setXYZ + needsUpdate pattern works in some configurations and
    // not others (the buffer mutates but the upload is sometimes skipped),
    // which produced the "everything looks the same color" bug.
    if (this._instancedMesh) {
      const tmp = new THREE.Color();
      const idxMap = this._instancedIndex;
      for (const n of nodes) {
        if (!idxMap) break;
        const idx = idxMap.get(n.id);
        if (idx === undefined) continue;
        tmp.copy(colorFor(n));
        this._instancedMesh.setColorAt(idx, tmp);
      }
      // setColorAt creates instanceColor lazily if absent, but doesn't flag
      // needsUpdate. Without this the GPU buffer keeps its previous values.
      if (this._instancedMesh.instanceColor) {
        this._instancedMesh.instanceColor.needsUpdate = true;
      }
    } else {
      // Individual-mesh path — direct material color update.
      for (const n of nodes) {
        const mesh = this._nodeObjects.get(n.id);
        if (!mesh) continue;
        const c = colorFor(n);
        mesh.material.color.copy(c);
        mesh.material.emissive.copy(c);
      }
    }
    this._sliceMode = true;
    // Diagnostic — routed to /api/log so it's visible in results/research.log
    // when the dev console is unavailable (e.g. Claude Code preview sandbox).
    // The line carries the four-color tally and the average / max cross-hem
    // peer count so we can tell, on sight, whether the visualization matches
    // the routing-table state.
    //
    // Throttled to once per 500 ms because onProgress fires on every yield
    // (which is every lookup at YIELD_EVERY = 1). Without a throttle we'd
    // spam the log with hundreds of identical lines per training session.
    const now = Date.now();
    if (!this._sliceLastDiagAt || now - this._sliceLastDiagAt >= 500) {
      this._sliceLastDiagAt = now;
      // Recompute aggregate cross-hem stats — we discarded the per-node
      // counts above (we only kept the bucket sums). One more cheap pass
      // for diagnostic colour: avg + max non-bridge cross-hem peers.
      let sum = 0, max = 0, n = 0;
      for (const node of nodes) {
        if (!node.alive) continue;
        const c = countCrossHemPeers(node);
        sum += c;
        if (c > max) max = c;
        n++;
      }
      const avg = n > 0 ? (sum / n).toFixed(2) : '0';
      const diagLine = `[SLICE-COLORS] yellow=${counts.yellow}, white=${counts.white}, green=${counts.green}, dead=${counts.dead}, cross-hem-avg=${avg}, cross-hem-max=${max}`;
      if (typeof console !== 'undefined') console.log(diagLine);
      if (typeof fetch !== 'undefined') {
        try {
          fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entry: diagLine }),
          }).catch(() => {});
        } catch { /* non-browser environment */ }
      }
    }
  }

  /** Exit Slice World coloring. Subsequent updateNodeState calls revert
   *  to the standard alive / dead palette. */
  clearSliceMode() {
    this._sliceMode = false;
    this._sliceBridgeId = undefined;
  }

  /** True if we're currently rendering Slice World colors. */
  isSliceMode() {
    return this._sliceMode === true;
  }

  updateNodeState(nodeId, alive) {
    const data = this._nodeDataMap.get(nodeId);
    if (data) data.alive = alive;

    // Individual mesh mode
    const mesh = this._nodeObjects.get(nodeId);
    if (mesh) {
      const col = alive ? C.nodeAlive : C.nodeDead;
      mesh.material.color.setHex(col);
      mesh.material.emissive.setHex(col);
      return;
    }

    // Instanced mode
    if (this._instancedMesh && this._instancedIndex) {
      const idx = this._instancedIndex.get(nodeId);
      if (idx === undefined) return;
      const col = alive ? C.nodeAlive : C.nodeDead;
      const color = new THREE.Color(col);
      const attr = this._instancedMesh.instanceColor;
      attr.setXYZ(idx, color.r, color.g, color.b);
      attr.needsUpdate = true;
    }
  }

  // ── Routing-table connection display ──────────────────────────────────────

  /**
   * Highlight a node and draw bright connection arcs to every node in its
   * routing table.  Called from main.js when a node is clicked.
   *
   * @param {number}   nodeId          – the clicked node
   * @param {Map}      nodeMap         – id → node object (with lat/lng)
   * @param {number[]} routingTableIds – all IDs the clicked node knows about
   */
  showNodeConnections(nodeId, nodeMap, routingTableIds) {
    this.clearConnections();
    this._selectedId = nodeId;

    const src = nodeMap.get(nodeId);
    if (!src) return;

    // ── Orbit arc constants ──────────────────────────────────────────────
    // Each connection follows the great-circle path between two nodes.
    // The middle section travels at constant radius R_ORBIT.
    // Each end has a quarter-circle-profile ramp connecting the node
    // (at R_NODE) to the orbit circle (at R_ORBIT).
    const R_NODE  = GLOBE_RADIUS * 1.009;  // node elevation
    const R_ORBIT = GLOBE_RADIUS * 1.11;   // orbit circle radius (11 % above surface)
    const R_TRANS = R_ORBIT - R_NODE;      // ramp height = quarter-circle radius

    // ── Highlight the selected node (bright yellow) ──────────────────────
    const selMesh = this._nodeObjects.get(nodeId);
    if (selMesh) {
      selMesh.material.color.setHex(C.nodeSelected);
      selMesh.material.emissive.setHex(C.nodeSelected);
      selMesh.material.emissiveIntensity = 1.0;
    }
    this._setInstancedColor(nodeId, C.nodeSelected);

    // Unit vector for the source node
    const ra = this._v3(src.lat, src.lng, 1).normalize();

    // ── Draw connection lines ────────────────────────────────────────────
    for (const tid of routingTableIds) {
      const tgt = nodeMap.get(tid);
      if (!tgt) continue;

      const rb = this._v3(tgt.lat, tgt.lng, 1).normalize();

      // Angular separation along the great circle
      const omega = Math.acos(Math.max(-1, Math.min(1, ra.dot(rb))));
      if (omega < 0.001) continue; // skip coincident nodes

      // Ramp fraction: portion of arc used by each end ramp.
      // The ramp covers ~R_TRANS radians of arc (since R_ORBIT ≈ 1).
      const rampFrac = Math.min(R_TRANS / omega, 0.45);

      const N    = 64;
      const sinΩ = Math.sin(omega);
      const pts  = [];

      for (let i = 0; i <= N; i++) {
        const t  = i / N;

        // SLERP: smoothly interpolate direction along the great circle
        const w0  = Math.sin((1 - t) * omega) / sinΩ;
        const w1  = Math.sin(t * omega) / sinΩ;
        const dir = new THREE.Vector3(
          ra.x * w0 + rb.x * w1,
          ra.y * w0 + rb.y * w1,
          ra.z * w0 + rb.z * w1,
        ).normalize(); // ensure unit length

        // Height profile: sine-shaped quarter-circle ramps at each end,
        // flat orbit section in the middle.
        let h;
        if (t < rampFrac) {
          h = R_NODE + R_TRANS * Math.sin((t / rampFrac) * (Math.PI / 2));
        } else if (t > 1 - rampFrac) {
          h = R_NODE + R_TRANS * Math.sin(((1 - t) / rampFrac) * (Math.PI / 2));
        } else {
          h = R_ORBIT;
        }

        pts.push(dir.multiplyScalar(h));
      }

      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color: C.connLine, transparent: true, opacity: 0.95, depthWrite: false,
      });
      this.connGroup.add(new THREE.Line(geo, mat));

      // Tint the connected node light-blue
      const tgtMesh = this._nodeObjects.get(tid);
      if (tgtMesh) {
        tgtMesh.material.color.setHex(C.connNodeHighlight);
        tgtMesh.material.emissive.setHex(C.connNodeHighlight);
        tgtMesh.material.emissiveIntensity = 0.9;
      }
      this._setInstancedColor(tid, C.connNodeHighlight);
    }
  }

  /**
   * Overlay a pub/sub AXON TREE: draw a bright-green great-circle arc for every
   * parent→child edge (root→subscriber, root→sub-axon, sub-axon→subscriber).
   * This is the pub/sub delivery tree (role.children), NOT the routing mesh.
   * All arcs are merged into ONE LineSegments so thousands of edges stay cheap.
   *
   * @param {Array<[bigint,bigint]>} edges   parent→child node-id pairs
   * @param {Map} nodeMap                     id → { lat, lng }
   * @param {object} [opts]
   * @param {Iterable<bigint>} [opts.roots]   root/sub-axon ids to highlight brighter
   */
  showAxonTree(edges, nodeMap, opts = {}) {
    this.clearConnections();
    const COLOR_EDGE = 0x00ff66;   // bright green
    const COLOR_LEAF = 0x39ff8a;   // green node tint
    const COLOR_ROOT = 0xeaff00;   // yellow-green for roots/sub-axons

    const R_NODE  = GLOBE_RADIUS * 1.009;
    const R_ORBIT = GLOBE_RADIUS * 1.06;     // lower orbit than routing arcs so the tree reads as its own layer
    const R_TRANS = R_ORBIT - R_NODE;

    const positions = [];
    const touched = new Set();
    for (const [pid, cid] of edges) {
      const a = nodeMap.get(pid), b = nodeMap.get(cid);
      if (!a || !b) continue;
      touched.add(pid); touched.add(cid);
      const ra = this._v3(a.lat, a.lng, 1).normalize();
      const rb = this._v3(b.lat, b.lng, 1).normalize();
      const omega = Math.acos(Math.max(-1, Math.min(1, ra.dot(rb))));
      if (omega < 0.001) continue;
      const rampFrac = Math.min(R_TRANS / omega, 0.45);
      const N = 24, sinO = Math.sin(omega);
      let prev = null;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const w0 = Math.sin((1 - t) * omega) / sinO;
        const w1 = Math.sin(t * omega) / sinO;
        const dir = new THREE.Vector3(
          ra.x * w0 + rb.x * w1, ra.y * w0 + rb.y * w1, ra.z * w0 + rb.z * w1,
        ).normalize();
        let h;
        if (t < rampFrac)       h = R_NODE + R_TRANS * Math.sin((t / rampFrac) * (Math.PI / 2));
        else if (t > 1 - rampFrac) h = R_NODE + R_TRANS * Math.sin(((1 - t) / rampFrac) * (Math.PI / 2));
        else                    h = R_ORBIT;
        const p = dir.multiplyScalar(h);
        if (prev) positions.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);  // emit as line segments
        prev = p;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color: COLOR_EDGE, transparent: true, opacity: 0.85, depthWrite: false });
    this.connGroup.add(new THREE.LineSegments(geo, mat));

    // Tint participant nodes; roots/sub-axons brighter.
    for (const id of touched) this._setInstancedColor(id, COLOR_LEAF);
    for (const id of (opts.roots || [])) this._setInstancedColor(id, COLOR_ROOT);
    return { edges: edges.length, nodes: touched.size };
  }

  clearConnections() {
    this.connGroup.clear();
    // Restore colours for previously highlighted individual-mesh nodes.
    this._nodeObjects.forEach((mesh, id) => {
      const data = this._nodeDataMap.get(id);
      if (!data) return;
      const col = data.alive ? C.nodeAlive : C.nodeDead;
      mesh.material.color.setHex(col);
      mesh.material.emissive.setHex(col);
      mesh.material.emissiveIntensity = 0.7;
    });
    // Restore instance colours for previously highlighted instanced nodes.
    // We rebuild from the authoritative alive/dead state in _nodeDataMap
    // since the per-instance highlight state isn't stored separately.
    if (this._instancedMesh && this._instancedIndex) {
      const attr = this._instancedMesh.instanceColor;
      const c = new THREE.Color();
      for (const [id, idx] of this._instancedIndex) {
        const data = this._nodeDataMap.get(id);
        if (!data) continue;
        c.setHex(data.alive ? C.nodeAlive : C.nodeDead);
        attr.setXYZ(idx, c.r, c.g, c.b);
      }
      attr.needsUpdate = true;
    }
    this._selectedId = null;
  }

  /** Helper: set a single instance's colour by nodeId. No-op if not in
   *  instanced mode or the nodeId isn't in the map. */
  _setInstancedColor(nodeId, hex) {
    if (!this._instancedMesh || !this._instancedIndex) return;
    const idx = this._instancedIndex.get(nodeId);
    if (idx === undefined) return;
    const attr = this._instancedMesh.instanceColor;
    const c = new THREE.Color(hex);
    attr.setXYZ(idx, c.r, c.g, c.b);
    attr.needsUpdate = true;
  }

  // ── Raycasting (node clicks) ──────────────────────────────────────────────

  _setupRaycasting() {
    // Track pointer movement to distinguish a click from a drag
    this.canvas.addEventListener('pointerdown', () => { this._pointerMoved = false; });
    this.canvas.addEventListener('pointermove', () => { this._pointerMoved = true; });
    this.canvas.addEventListener('pointerup',   (e) => {
      if (!this._pointerMoved) this._handleClick(e);
    });
  }

  _handleClick(event) {
    if (this._nodeObjects.size === 0 && !this._instancedHitMesh) return;

    const rect = this.canvas.getBoundingClientRect();
    const ndc  = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width)  * 2 - 1,
      -((event.clientY - rect.top)  / rect.height) * 2 + 1
    );

    this._raycaster.setFromCamera(ndc, this.camera);

    // Camera direction used for the front-face filter: a node is
    // front-facing when its world position has a positive dot product
    // with the camera direction — works regardless of camera orientation.
    const cameraDir = this.camera.position.clone().normalize();

    // Collect all front-face hits from both modes, tagged with distance.
    // We pick the nearest overall so a click on an overlapping region
    // picks the closest node regardless of which rendering path holds it.
    const candidates = [];   // { nodeId, distance }

    // Individual mode: raycast against invisible (4×-larger) hit spheres.
    if (this._hitObjects.size) {
      const hitList = [...this._hitObjects.values()];
      const hits    = this._raycaster.intersectObjects(hitList, false);
      for (const h of hits) {
        if (h.object.position.dot(cameraDir) > 0) {
          candidates.push({ nodeId: h.object.userData.nodeId, distance: h.distance });
        }
      }
    }

    // Instanced mode: raycast against the invisible hit InstancedMesh.
    // Each hit carries an `instanceId` that maps back to a nodeId via
    // the reverse index built in _setNodesInstanced. For front-face
    // filtering we reconstruct the instance's world position from its
    // matrix (cheap — just pull the translation components).
    if (this._instancedHitMesh && this._instancedReverse) {
      const hits = this._raycaster.intersectObject(this._instancedHitMesh, false);
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      for (const h of hits) {
        if (h.instanceId == null) continue;
        this._instancedHitMesh.getMatrixAt(h.instanceId, m);
        p.setFromMatrixPosition(m);
        if (p.dot(cameraDir) > 0) {
          const nodeId = this._instancedReverse[h.instanceId];
          if (nodeId !== undefined) {
            candidates.push({ nodeId, distance: h.distance });
          }
        }
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => a.distance - b.distance);
      const nodeId = candidates[0].nodeId;
      this.canvas.dispatchEvent(new CustomEvent('nodeclicked', { detail: { nodeId } }));
    } else {
      // Click on empty space (or back of globe) → clear selection
      this.clearConnections();
      this.canvas.dispatchEvent(new CustomEvent('nodeclicked', { detail: { nodeId: null } }));
    }
  }

  // ── Routing arcs (lookup paths) ───────────────────────────────────────────

  showPath(path, nodeMap) {
    this.clearArcs();
    if (!path || path.length < 2) return;
    for (let i = 0; i < path.length - 1; i++) {
      const a = nodeMap.get(path[i]);
      const b = nodeMap.get(path[i + 1]);
      if (a && b) {
        const t = path.length > 2 ? i / (path.length - 2) : 0;
        this.arcGroup.add(this._buildArc(a, b, this._hopColor(t)));
      }
    }
  }

  async animatePath(path, nodeMap, delayMs = 380) {
    this.clearArcs();
    if (path.length < 2) return;

    // ── Intro: pan to source, then blink it twice ──────────────────────────
    const srcNode = nodeMap.get(path[0]);
    if (srcNode) {
      this.panToDir(this._v3(srcNode.lat, srcNode.lng, 1).normalize(), delayMs * 0.9);
      await new Promise(r => setTimeout(r, delayMs));   // let pan settle
      await this._blinkNode(path[0], 2, 260);
    }

    // ── Hop-by-hop ────────────────────────────────────────────────────────
    for (let i = 0; i < path.length - 1; i++) {
      const a = nodeMap.get(path[i]);
      const b = nodeMap.get(path[i + 1]);
      if (a && b) {
        const t = path.length > 2 ? i / (path.length - 2) : 0;
        this.arcGroup.add(this._buildArc(a, b, this._hopColor(t)));
        // Pan to destination node, completing before the next hop
        this.panToDir(this._v3(b.lat, b.lng, 1).normalize(), delayMs * 0.8);
      }
      await new Promise(r => setTimeout(r, delayMs));
    }

    // ── Outro: blink destination twice ────────────────────────────────────
    await this._blinkNode(path[path.length - 1], 2, 260);
  }

  /**
   * Flash a node orange and enlarge it to signal start or arrival.
   * @param {number} nodeId
   * @param {number} times     – number of flashes
   * @param {number} pulseMs   – duration of each on/off phase in ms
   */
  async _blinkNode(nodeId, times = 2, pulseMs = 260) {
    const data = this._nodeDataMap.get(nodeId);
    if (!data) return;

    // ── Individual mesh mode ────────────────────────────────────────────
    const mesh = this._nodeObjects.get(nodeId);
    if (mesh) {
      const normalColor = data.alive ? C.nodeAlive : C.nodeDead;
      for (let i = 0; i < times; i++) {
        mesh.material.color.setHex(0xff7700);
        mesh.material.emissive.setHex(0xff7700);
        mesh.material.emissiveIntensity = 2.0;
        mesh.scale.setScalar(2);
        await new Promise(r => setTimeout(r, pulseMs));
        mesh.material.color.setHex(normalColor);
        mesh.material.emissive.setHex(normalColor);
        mesh.material.emissiveIntensity = 0.7;
        mesh.scale.setScalar(1);
        await new Promise(r => setTimeout(r, pulseMs));
      }
      return;
    }

    // ── Instanced mode: flash via instance color ────────────────────────
    if (this._instancedMesh && this._instancedIndex) {
      const idx = this._instancedIndex.get(nodeId);
      if (idx === undefined) return;
      const attr = this._instancedMesh.instanceColor;
      const normalColor = new THREE.Color(data.alive ? C.nodeAlive : C.nodeDead);
      const flashColor  = new THREE.Color(0xff7700);
      for (let i = 0; i < times; i++) {
        attr.setXYZ(idx, flashColor.r, flashColor.g, flashColor.b);
        attr.needsUpdate = true;
        await new Promise(r => setTimeout(r, pulseMs));
        attr.setXYZ(idx, normalColor.r, normalColor.g, normalColor.b);
        attr.needsUpdate = true;
        await new Promise(r => setTimeout(r, pulseMs));
      }
    }
  }

  clearArcs() { this.arcGroup.clear(); }

  /**
   * Draw a geodesic circle on the globe surface showing the regional radius
   * boundary centred on (lat, lng).
   */
  drawRegionalBoundary(lat, lng, radiusKm) {
    this.clearRegionalBoundary();
    const d    = radiusKm / EARTH_RADIUS_KM; // angular radius in radians
    const lat1 = lat * Math.PI / 180;
    const lng1 = lng * Math.PI / 180;
    const N    = 128;
    const pts  = [];

    for (let i = 0; i <= N; i++) {
      const bearing = (i / N) * 2 * Math.PI;
      const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(d) +
        Math.cos(lat1) * Math.sin(d) * Math.cos(bearing)
      );
      const lng2 = lng1 + Math.atan2(
        Math.sin(bearing) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
      );
      const { x, y, z } = latLngToXYZ(
        lat2 * 180 / Math.PI, lng2 * 180 / Math.PI, GLOBE_RADIUS * 1.003
      );
      pts.push(new THREE.Vector3(x, y, z));
    }

    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffff00,
      depthTest:  false,   // always render on top of the globe mesh
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    });
    this._regionalCircle = new THREE.Line(geo, mat);
    this._regionalCircle.renderOrder = 999;  // draw after everything else
    this.scene.add(this._regionalCircle);
  }

  clearRegionalBoundary() {
    if (this._regionalCircle) {
      this.scene.remove(this._regionalCircle);
      this._regionalCircle.geometry.dispose();
      this._regionalCircle.material.dispose();
      this._regionalCircle = null;
    }
  }

  _hopColor(t) {
    // Bright yellow (#ffee00) → orange (#ff8800) → deep orange-red (#ff2200)
    // Chosen to maximise contrast against the green (#00ff88) nodes and the
    // dark blue globe background.
    const g = Math.round(0xee * Math.pow(1 - t, 0.6)); // rapid drop from 238→0
    const b = 0;
    return (0xff << 16) | (g << 8) | b;
  }

  _buildArc(nA, nB, color) {
    const R_NODE  = GLOBE_RADIUS * 1.009;
    const R_ORBIT = GLOBE_RADIUS * 1.11;
    const R_TRANS = R_ORBIT - R_NODE;

    const ra = this._v3(nA.lat, nA.lng, 1).normalize();
    const rb = this._v3(nB.lat, nB.lng, 1).normalize();

    const omega = Math.acos(Math.max(-1, Math.min(1, ra.dot(rb))));
    if (omega < 0.001) {
      return new THREE.Mesh(); // degenerate arc — skip silently
    }

    const rampFrac = Math.min(R_TRANS / omega, 0.45);
    const sinΩ = Math.sin(omega);
    const pts  = [];

    for (let i = 0; i <= 64; i++) {
      const t  = i / 64;
      const w0 = Math.sin((1 - t) * omega) / sinΩ;
      const w1 = Math.sin(t * omega) / sinΩ;
      const dir = new THREE.Vector3(
        ra.x * w0 + rb.x * w1,
        ra.y * w0 + rb.y * w1,
        ra.z * w0 + rb.z * w1,
      ).normalize();

      let h;
      if (t < rampFrac) {
        h = R_NODE + R_TRANS * Math.sin((t / rampFrac) * (Math.PI / 2));
      } else if (t > 1 - rampFrac) {
        h = R_NODE + R_TRANS * Math.sin(((1 - t) / rampFrac) * (Math.PI / 2));
      } else {
        h = R_ORBIT;
      }

      pts.push(dir.multiplyScalar(h));
    }

    // Use TubeGeometry so the arc has real pixel-independent thickness.
    // (LineBasicMaterial.linewidth is ignored by WebGL on most platforms.)
    const curve  = new THREE.CatmullRomCurve3(pts);
    const tubeGeo = new THREE.TubeGeometry(curve, 64, 0.0013, 5, false);
    return new THREE.Mesh(tubeGeo, new THREE.MeshBasicMaterial({ color }));
  }

  /**
   * Smoothly spin the camera to centre on a given direction vector.
   * @param {THREE.Vector3} dir  – unit vector from globe centre toward target
   * @param {number}        ms   – transition duration in milliseconds
   */
  panToDir(dir, ms = 600) {
    this._panStart    = this.camera.position.clone().normalize();
    this._panTarget   = dir.clone().normalize();
    this._panDuration = ms;
    this._panT        = 0;
  }

  /** Spherical linear interpolation between two unit vectors. */
  _slerpDir(a, b, t) {
    const dot = Math.max(-1, Math.min(1, a.dot(b)));
    if (dot > 0.9999) return b.clone();
    // Antipodal: pick an arbitrary perpendicular axis to rotate around
    if (dot < -0.9999) {
      const perp = Math.abs(a.x) < 0.9
        ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const axis = perp.cross(a).normalize();
      return a.clone().applyAxisAngle(axis, Math.PI * t);
    }
    const omega    = Math.acos(dot);
    const sinOmega = Math.sin(omega);
    const w0 = Math.sin((1 - t) * omega) / sinOmega;
    const w1 = Math.sin(t * omega) / sinOmega;
    return new THREE.Vector3(
      a.x * w0 + b.x * w1,
      a.y * w0 + b.y * w1,
      a.z * w0 + b.z * w1,
    );
  }

  _v3(lat, lng, r) {
    const { x, y, z } = latLngToXYZ(lat, lng, r);
    return new THREE.Vector3(x, y, z);
  }

  /**
   * Highlight the relay node (gold) and participant nodes (cyan) for the
   * current pub/sub group.  Clears any previous pub/sub highlights first.
   *
   * @param {bigint}   relayId        – node ID of the relay
   * @param {bigint[]} participantIds – node IDs of the subscribers
   */
  highlightPubSubGroup(relayId, participantIds) {
    this.clearPubSubHighlights();

    const setHighlight = (id, color, intensity, scale) => {
      const mesh = this._nodeObjects.get(id);
      if (mesh) {
        mesh.material.color.setHex(color);
        mesh.material.emissive.setHex(color);
        mesh.material.emissiveIntensity = intensity;
        mesh.scale.setScalar(scale);
      }
      // Instanced mode: recolour only (per-instance scale would require
      // per-instance matrix updates — the colour change alone is enough
      // to identify the relay / participant visually).
      this._setInstancedColor(id, color);
      this._pubsubHighlighted.add(id);
    };

    setHighlight(relayId, C.pubsubRelay, 2.5, 2.0);
    for (const id of participantIds) {
      setHighlight(id, C.pubsubParticipant, 1.8, 2.0);
    }
  }

  /** Restore all pub/sub-highlighted nodes to their normal alive colour. */
  clearPubSubHighlights() {
    for (const id of this._pubsubHighlighted) {
      const data = this._nodeDataMap.get(id);
      if (!data) continue;
      const col = data.alive ? C.nodeAlive : C.nodeDead;
      const mesh = this._nodeObjects.get(id);
      if (mesh) {
        mesh.material.color.setHex(col);
        mesh.material.emissive.setHex(col);
        mesh.material.emissiveIntensity = 0.7;
        mesh.scale.setScalar(1);
      }
      this._setInstancedColor(id, col);
    }
    this._pubsubHighlighted.clear();
  }

  /**
   * Smoothly pan the camera to centre on a geographic coordinate.
   * Convenience wrapper around panToDir that handles the lat/lng → 3-D
   * direction conversion so callers don't need to import latLngToXYZ.
   *
   * @param {number} lat  – latitude  in degrees
   * @param {number} lng  – longitude in degrees
   * @param {number} [ms=600] – transition duration in milliseconds
   */
  panToLatLng(lat, lng, ms = 600) {
    this.panToDir(this._v3(lat, lng, 1), ms);
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  _startRenderLoop() {
    let lastTime = performance.now();
    const loop = (now) => {
      this._animFrame = requestAnimationFrame(loop);
      const dt = now - lastTime;
      lastTime = now;

      // Smooth camera pan – SLERP camera direction toward target
      if (this._panTarget && this._panT < 1) {
        this._panT = Math.min(1, this._panT + dt / this._panDuration);
        // Quadratic ease-in-out
        const e = this._panT < 0.5
          ? 2 * this._panT * this._panT
          : -1 + (4 - 2 * this._panT) * this._panT;
        const dist = this.camera.position.length();
        const dir  = this._slerpDir(this._panStart, this._panTarget, e);
        this.camera.position.copy(dir.multiplyScalar(dist));
      }

      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(loop);
  }

  _onResize() {
    const W = this.canvas.clientWidth  || 800;
    const H = this.canvas.clientHeight || 600;
    this.renderer.setSize(W, H, false);
    this.camera.aspect = W / H;
    this.camera.updateProjectionMatrix();
  }

  setAutoRotate(v) { this.controls.autoRotate = v; }

  setTheme(isLight) {
    this.renderer.setClearColor(isLight ? 0x6ab0e8 : 0x010810);

    if (this._globeMesh && this._geoJSON) {
      // Same globe colours for both themes — only background differs
      this.landMask._buildTexture(true);
      this._globeMesh.material.map = this.landMask.texture;
      this._globeMesh.material.color.setHex(0x88b8dd);
      this._globeMesh.material.specular.setHex(0x446688);
      this._globeMesh.material.shininess = 4;
      this._globeMesh.material.needsUpdate = true;
      this._renderBorderLines(this._geoJSON, true);
    }
  }

  dispose() {
    cancelAnimationFrame(this._animFrame);
    this.renderer.dispose();
  }
}
