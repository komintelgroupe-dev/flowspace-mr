import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import type { World } from '@iwsdk/core';

/** V4-B.2: fixed machine identities, independent physical slots, and a parking library. */
type Pose = { position: Vector3; quaternion: Quaternion };
export type PlaceResult = 'swapped' | 'snapped' | 'reverted' | 'occupied';
export type FactoryLayoutSnapshot = {
  schema: 'flowspace-mr-layout';
  version: 1;
  /** Logical machine ID -> physical slot ID; null means stored in the library. */
  slots: [number | null, number | null, number | null];
  /** Machine root orientations, X/Y/Z/W. No production state is stored. */
  rotations: [[number, number, number, number], [number, number, number, number], [number, number, number, number]];
};

/** Defensive validation for imported JSON and browser storage. */
export function parseFactoryLayoutSnapshot(raw: unknown): FactoryLayoutSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.schema !== 'flowspace-mr-layout' || record.version !== 1) return null;
  const { slots, rotations } = record;
  if (!Array.isArray(slots) || slots.length !== 3 ||
      !slots.every((v: unknown) => v === null || (Number.isInteger(v) && typeof v === 'number' && v >= 0 && v <= 2))) return null;
  if (new Set(slots.filter((v: unknown) => v !== null)).size !== slots.filter((v: unknown) => v !== null).length) return null;
  if (!Array.isArray(rotations) || rotations.length !== 3 || !rotations.every((q: unknown) => {
    if (!Array.isArray(q) || q.length !== 4 || !q.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))) return false;
    const normSq = q.reduce((sum: number, value: number) => sum + value * value, 0);
    return normSq >= 0.25 && normSq <= 2.25;
  })) return null;
  return {
    schema: 'flowspace-mr-layout', version: 1,
    slots: [slots[0], slots[1], slots[2]],
    rotations: rotations.map((q: number[]) => [q[0], q[1], q[2], q[3]]) as FactoryLayoutSnapshot['rotations'],
  };
}

const SLOT_X = [-1.55, 0, 1.55] as const;
const SLOT_Z = -2.89;
const SNAP_RADIUS = 0.84;
const CLEARANCE = 0.025;
const FLOOR_MIN_X = -2.575;
const FLOOR_MAX_X = 2.575;
const FLOOR_MIN_Z = -3.475;
const FLOOR_MAX_Z = -1.725;

const clonePose = (mesh: Mesh): Pose => ({
  position: mesh.position.clone(), quaternion: mesh.quaternion.clone(),
});

export class SmartFactoryLayout {
  private machineSlots: Array<number | null> = [0, 1, 2];
  private committed: Pose[];
  private initial: Pose[];
  private guides: Array<{ mesh: Mesh; entity: ReturnType<World['createTransformEntity']> }> = [];
  private guidesVisible = false;
  private previewSlot: number | null = null;
  private previewAllowed = false;

  constructor(private world: World, private machines: Mesh[]) {
    if (machines.length !== 3 || machines.some(m => !m)) {
      throw new Error('SmartFactoryLayout requires exactly three machine roots');
    }
    this.initial = machines.map(clonePose);
    this.committed = machines.map(clonePose);
    for (let i = 0; i < 3; i++) {
      const mesh = new Mesh(
        new BoxGeometry(1.10, 0.012, 0.85),
        new MeshBasicMaterial({ color: i === 1 ? 0xff6b00 : 0x4596fc, transparent: true, opacity: 0.22, depthWrite: false }),
      );
      mesh.position.set(SLOT_X[i], 0.605, SLOT_Z);
      const entity = world.createTransformEntity(mesh);
      mesh.visible = false;
      this.guides.push({ mesh, entity });
    }
  }

  showGuides(visible: boolean): void {
    this.guidesVisible = visible;
    if (!visible) this.previewSlot = null;
    this.refreshGuides();
  }

  /** 3D palette drop: determine target by projection of the real factory slot onto the screen.
   *  This avoids relying on a generic DOM drop-zone: the pointer must be over the 3D scene.
   *  The snap remains intentionally limited to the three physical stations. */
  pickSlotAtScreen(clientX: number, clientY: number): number | null {
    if (!this.guidesVisible) return null;
    const canvas = document.querySelector<HTMLCanvasElement>('#scene-container canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 ||
        clientX < rect.left || clientX > rect.right ||
        clientY < rect.top || clientY > rect.bottom) return null;
    const camera = this.world.camera;
    camera.updateWorldMatrix(true, false);
    let best: number | null = null;
    let bestRatio = Number.POSITIVE_INFINITY;
    const screen = (point: Vector3) => {
      const p = point.project(camera);
      return { x: rect.left + (p.x + 1) * rect.width / 2,
               y: rect.top + (1 - p.y) * rect.height / 2,
               behind: p.z > 1 || p.z < -1 };
    };
    for (let slot = 0; slot < 3; slot++) {
      const center = screen(new Vector3(SLOT_X[slot], 0.97, SLOT_Z));
      if (center.behind) continue;
      const edgeX = screen(new Vector3(SLOT_X[slot] + 0.57, 0.97, SLOT_Z));
      const edgeZ = screen(new Vector3(SLOT_X[slot], 0.97, SLOT_Z + 0.45));
      const reach = Math.min(140, Math.max(38,
        Math.hypot(edgeX.x - center.x, edgeX.y - center.y),
        Math.hypot(edgeZ.x - center.x, edgeZ.y - center.y)));
      const ratio = Math.hypot(clientX - center.x, clientY - center.y) / reach;
      if (ratio <= 1 && ratio < bestRatio) { best = slot; bestRatio = ratio; }
    }
    return best;
  }

  canDropMachine(machine: number, slot: number): boolean {
    if (!this.validIndex(machine) || slot < 0 || slot > 2 || !Number.isInteger(slot)) return false;
    return !this.isParked(machine) || this.getOccupant(slot) === null;
  }

  previewDrop(slot: number | null, allowed: boolean): void {
    if (this.previewSlot === slot && this.previewAllowed === allowed) return;
    this.previewSlot = slot;
    this.previewAllowed = allowed;
    this.refreshGuides();
  }

  private refreshGuides(): void {
    for (let s = 0; s < 3; s++) {
      const { mesh } = this.guides[s];
      mesh.visible = this.guidesVisible;
      const selected = this.previewSlot === s;
      const material = mesh.material as MeshBasicMaterial;
      material.color.setHex(selected ? (this.previewAllowed ? 0x39f58c : 0xff4444) :
        this.getOccupant(s) === null ? 0x22c55e : (s === 1 ? 0xff6b00 : 0x4596fc));
      material.opacity = selected ? 0.72 : 0.22;
      mesh.scale.set(selected ? 1.12 : 1, 1, selected ? 1.12 : 1);
    }
  }

  isParked(machineIndex: number): boolean {
    return this.machineSlots[machineIndex] === null;
  }

  hasParked(): boolean {
    return this.machineSlots.includes(null);
  }

  getSlot(machineIndex: number): number | null {
    return this.machineSlots[machineIndex] ?? null;
  }

  getOccupant(slot: number): number | null {
    if (!Number.isInteger(slot) || slot < 0 || slot > 2) return null;
    const index = this.machineSlots.indexOf(slot);
    return index === -1 ? null : index;
  }

  /** Preserve the machine and its simulated state; only hide its 3D assembly. */
  park(machineIndex: number): boolean {
    if (!this.validIndex(machineIndex) || this.isParked(machineIndex)) return false;
    const m = this.machines[machineIndex];
    m.position.copy(this.committed[machineIndex].position);
    m.quaternion.copy(this.committed[machineIndex].quaternion);
    m.visible = false;
    this.machineSlots[machineIndex] = null;
    this.refreshGuides();
    return true;
  }

  restore(machineIndex: number): void {
    if (!this.validIndex(machineIndex) || this.isParked(machineIndex)) return;
    const m = this.machines[machineIndex];
    const p = this.committed[machineIndex];
    m.position.copy(p.position);
    m.quaternion.copy(p.quaternion);
    m.updateWorldMatrix(true, true);
  }

  restoreAll(): void {
    for (let i = 0; i < 3; i++) this.restore(i);
  }

  /** For desktop Library buttons and HTML drag-and-drop. */
  placeMachine(machineIndex: number, slot: number): PlaceResult {
    if (!this.validIndex(machineIndex) || !Number.isInteger(slot) || slot < 0 || slot > 2) return 'reverted';
    const source = this.machineSlots[machineIndex];
    const occupant = this.getOccupant(slot);
    if (source === null && occupant !== null) return 'occupied';
    if (source === slot) return 'snapped';
    return this.commitMove(machineIndex, slot, occupant, source);
  }

  /** For XR Grab release: nearest-slot placement or swap. */
  drop(machineIndex: number): PlaceResult {
    if (!this.validIndex(machineIndex) || this.isParked(machineIndex)) return 'reverted';
    const destination = this.nearestSlot(this.machines[machineIndex].position);
    if (destination < 0) {
      this.restore(machineIndex);
      return 'reverted';
    }
    const source = this.machineSlots[machineIndex];
    const occupant = this.getOccupant(destination);
    return this.commitMove(machineIndex, destination, occupant, source);
  }

  /** Save the currently committed slots (including parked machines) and orientations.
   * If the on-screen machine is snapped and the whole layout is valid, commit any
   * inspection rotation before saving. Uncommitted mid-grab poses are not saved. */
  snapshot(): FactoryLayoutSnapshot | null {
    const allAtSlots = this.machines.every((m, i) => {
      const slot = this.machineSlots[i];
      if (slot === null) return true;
      return Math.abs(m.position.x - SLOT_X[slot]) < 0.02 &&
        Math.abs(m.position.z - SLOT_Z) < 0.02;
    });
    if (!allAtSlots) return null;
    if (!this.isValidLayout()) return null;
    this.committed = this.machines.map(clonePose);
    const rotation = (q: Quaternion): [number, number, number, number] =>
      [q.x, q.y, q.z, q.w];
    return {
      schema: 'flowspace-mr-layout', version: 1,
      slots: [this.machineSlots[0], this.machineSlots[1], this.machineSlots[2]],
      rotations: [rotation(this.committed[0].quaternion), rotation(this.committed[1].quaternion), rotation(this.committed[2].quaternion)],
    };
  }

  /** Apply saved layout atomically. Invalid/overlapping/oversized layouts do not alter the scene. */
  applySnapshot(raw: unknown): boolean {
    const data = parseFactoryLayoutSnapshot(raw);
    if (!data) return false;
    const oldSlots = [...this.machineSlots];
    const oldPoses = this.machines.map(clonePose);
    const oldVisible = this.machines.map(m => m.visible);
    const oldCommitted = this.committed.map(p => ({ position: p.position.clone(), quaternion: p.quaternion.clone() }));
    this.machineSlots = [...data.slots];
    for (let i = 0; i < 3; i++) {
      const mesh = this.machines[i];
      const slot = data.slots[i];
      const [x, y, z, w] = data.rotations[i];
      mesh.quaternion.set(x, y, z, w).normalize();
      const center = slot === null ? this.initial[i].position :
        new Vector3(SLOT_X[slot], this.initial[i].position.y, SLOT_Z);
      mesh.position.copy(center);
      mesh.visible = slot !== null;
      mesh.updateWorldMatrix(true, true);
    }
    if (!this.isValidLayout()) {
      this.rollback(oldSlots, oldPoses, oldVisible);
      this.committed = oldCommitted;
      return false;
    }
    this.committed = this.machines.map(clonePose);
    this.refreshGuides();
    return true;
  }

  resetLayout(): void {
    this.machineSlots = [0, 1, 2];
    for (let i = 0; i < 3; i++) {
      const m = this.machines[i];
      m.position.copy(this.initial[i].position);
      m.quaternion.copy(this.initial[i].quaternion);
      m.visible = true;
      m.updateWorldMatrix(true, true);
    }
    this.committed = this.machines.map(clonePose);
    this.refreshGuides();
  }

  private validIndex(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < this.machines.length;
  }

  private nearestSlot(position: Vector3): number {
    let best = -1;
    let bestDistance = SNAP_RADIUS;
    for (let i = 0; i < 3; i++) {
      const d = Math.hypot(position.x - SLOT_X[i], position.z - SLOT_Z);
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    return best;
  }

  private positionAtSlot(i: number, slot: number): void {
    const mesh = this.machines[i];
    const y = this.committed[i].position.y;
    mesh.position.set(SLOT_X[slot], y, SLOT_Z);
    mesh.updateWorldMatrix(true, true);
  }

  /** A single transaction: never leave the visual or logical layout half-swapped. */
  private commitMove(i: number, dest: number, occupant: number | null, source: number | null): PlaceResult {
    const oldSlots = [...this.machineSlots];
    const oldPoses = this.machines.map(clonePose);
    const oldVisible = this.machines.map(m => m.visible);
    this.machineSlots[i] = dest;
    this.machines[i].visible = true;
    this.positionAtSlot(i, dest);
    if (occupant !== null && occupant !== i) {
      if (source === null) { this.rollback(oldSlots, oldPoses, oldVisible); return 'occupied'; }
      this.machineSlots[occupant] = source;
      this.positionAtSlot(occupant, source);
    }
    if (!this.isValidLayout()) {
      this.rollback(oldSlots, oldPoses, oldVisible);
      // XR drops must restore the last committed pose, not an invalid dragged pose.
      this.restore(i);
      return 'reverted';
    }
    this.committed = this.machines.map(clonePose);
    this.refreshGuides();
    return occupant !== null && occupant !== i ? 'swapped' : 'snapped';
  }

  private rollback(slots: Array<number | null>, poses: Pose[], visible: boolean[]): void {
    this.machineSlots = slots;
    for (let i = 0; i < 3; i++) {
      const m = this.machines[i];
      m.position.copy(poses[i].position);
      m.quaternion.copy(poses[i].quaternion);
      m.visible = visible[i];
      m.updateWorldMatrix(true, true);
    }
    this.refreshGuides();
  }

  private isValidLayout(): boolean {
    const boxes = this.machines.map((m, i) => {
      if (this.machineSlots[i] === null) return null;
      m.updateWorldMatrix(true, true);
      return new Box3().setFromObject(m).expandByScalar(CLEARANCE);
    });
    for (const b of boxes) {
      if (!b) continue;
      if (b.isEmpty() || b.min.x < FLOOR_MIN_X || b.max.x > FLOOR_MAX_X ||
        b.min.z < FLOOR_MIN_Z || b.max.z > FLOOR_MAX_Z) return false;
    }
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const left = boxes[i];
        const right = boxes[j];
        if (left && right && left.intersectsBox(right)) return false;
      }
    }
    return true;
  }

  dispose(): void {
    this.previewSlot = null;
    for (const { mesh, entity } of this.guides) {
      entity.destroy();
      mesh.geometry.dispose();
      (mesh.material as MeshBasicMaterial).dispose();
    }
    this.guides.length = 0;
  }
}
