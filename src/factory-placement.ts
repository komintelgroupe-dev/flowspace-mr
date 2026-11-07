import { Group, Mesh, MeshBasicMaterial, SphereGeometry, Vector3, type Object3D } from 'three';
import { DistanceGrabbable, GrabSystem, MovementMode, RayInteractable, type World } from '@iwsdk/core';
import { VirtualSurfacePlacement } from './virtual-surface-placement.js';

/** V4-C.1: One presentation transform for the entire factory, without changing
 * each machine's local position, slot IDs, or production state.
 * This is tabletop PREVIEW, not real-world surface detection or anchoring. */
type Pose = { x: number; y: number; z: number; yaw: number; scale: number };
const FULL: Pose = { x: 0, y: 0.53, z: -2.60, yaw: 0, scale: 1 };
const TABLETOP: Pose = { x: 0, y: 0.80, z: -2.20, yaw: 0, scale: 0.28 };

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

export class FactoryPlacementController {
  readonly root = new Group();
  private readonly content = new Group();
  private readonly rootEntity: ReturnType<World['createTransformEntity']>;
  private readonly contentEntity: ReturnType<World['createTransformEntity']>;
  private readonly grabMesh: Mesh;
  private readonly grabEntity: ReturnType<World['createTransformEntity']>;
  private factoryGrabEnabled = false;
  private grabActive = false;
  private grabStartPose: Pose | null = null;
  private grabStartPosition = new Vector3();
  private grabStartYaw = 0;
  private pose: Pose = { ...FULL };
  private editingLayout = false;
  private readonly panel: HTMLDivElement;
  private surfacePlacement: VirtualSurfacePlacement | null = null;

  constructor(private readonly world: World, private readonly onPlacementChanged: () => void) {
    this.root.name = 'FlowSpace-Factory-Presentation-Root';
    this.content.name = 'FlowSpace-Factory-Local-Coordinates';
    // Original geometry uses global-looking coordinates centered at (0,.53,-2.6).
    // The inner offset maintains EXACTLY the original appearance at full scale.
    this.content.position.set(-FULL.x, -FULL.y, -FULL.z);
    // Register both parents in the IWSDK ECS hierarchy.  Merely calling
    // Object3D.add(...) does not register the parent relationship in ECS.
    this.rootEntity = world.createTransformEntity(this.root);
    this.contentEntity = world.createTransformEntity(this.content, {
      parent: this.rootEntity,
    });
    // This dedicated handle belongs to the XR level, NOT to Factory Root.
    // It is always separate from the machine bodies and their grab handles.
    this.grabMesh = new Mesh(
      new SphereGeometry(0.17, 16, 12),
      new MeshBasicMaterial({ color: 0xff6b00, depthTest: false }),
    );
    this.grabMesh.name = 'FlowSpace-Whole-Factory-XR-Grab-Handle';
    this.grabMesh.visible = false;
    this.grabMesh.renderOrder = 101;
    this.grabEntity = world.createTransformEntity(this.grabMesh);
    this.apply();

    this.panel = document.createElement('div');
    this.panel.id = 'flowspace-factory-placement';
    this.panel.style.cssText = [
      'position:fixed','z-index:9996','bottom:16px','left:50%',
      'transform:translateX(-50%)','max-width:calc(100vw - 32px)',
      'width:420px','max-height:35vh','overflow-y:auto','box-sizing:border-box',
      'padding:12px','border:1px solid #ff6b00','border-radius:12px',
      'background:rgba(20,36,58,.96)','color:#fff',
      'font:12px/1.4 Arial,sans-serif','box-shadow:0 6px 28px #0005',
    ].join(';');
    this.panel.innerHTML = `
      <div style="font-weight:700;font-size:15px;margin-bottom:8px">Factory Placement · V4-C.3</div>
      <div style="display:flex;gap:7px;margin-bottom:9px;flex-wrap:wrap">
        <button data-placement="tabletop">Tabletop (28%)</button>
        <button data-placement="full">Full size</button>
        <button data-placement="reset">Reset position</button>
        <button data-placement="grab-mode">Enable Factory Grab (XR)</button>
      </div>
      <div style="display:grid;grid-template-columns:88px 1fr 50px;gap:7px;align-items:center">
        <label for="flow-place-scale">Scale</label><input id="flow-place-scale" data-pose="scale" type="range" min="0.16" max="1.20" step="0.01"><output data-value="scale"></output>
        <label for="flow-place-yaw">Rotation Y</label><input id="flow-place-yaw" data-pose="yaw" type="range" min="0" max="360" step="1"><output data-value="yaw"></output>
        <label for="flow-place-x">Left / Right</label><input id="flow-place-x" data-pose="x" type="range" min="-2.5" max="2.5" step="0.05"><output data-value="x"></output>
        <label for="flow-place-y">Height</label><input id="flow-place-y" data-pose="y" type="range" min="0.2" max="2.2" step="0.05"><output data-value="y"></output>
        <label for="flow-place-z">Near / Far</label><input id="flow-place-z" data-pose="z" type="range" min="-5" max="-0.5" step="0.05"><output data-value="z"></output>
      </div>
      <div style="opacity:.75;font-size:11px;margin-top:8px">To move the whole factory: switch to Simulation Mode, enable Factory Grab, point at the orange sphere above the factory, then hold Grip in IWER. Disable Grab before Start. Layout Mode still moves machines individually. No real-world anchor yet.</div>
    `;
    this.panel.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      button.style.cssText = 'padding:7px 9px;background:#123c8c;border:1px solid #597aab;border-radius:7px;color:white;cursor:pointer';
    });
    this.panel.querySelectorAll<HTMLInputElement>('input[type=range]').forEach(input => {
      input.style.width = '100%'; input.style.accentColor = '#ff6b00';
    });
    this.panel.addEventListener('click', event => {
      const element = event.target;
      if (!(element instanceof Element)) return;
      const button = element.closest<HTMLButtonElement>('button[data-placement]');
      if (!button) return;
      if (button.dataset.placement === 'grab-mode') {
        this.setFactoryGrabEnabled(!this.factoryGrabEnabled);
        return;
      }
      if (button.dataset.placement === 'tabletop') this.pose = { ...TABLETOP };
      if (button.dataset.placement === 'full') this.pose = { ...FULL };
      if (button.dataset.placement === 'reset') this.pose = { ...FULL };
      this.changed();
    });
    this.panel.addEventListener('input', event => {
      const element = event.target;
      if (!(element instanceof HTMLInputElement)) return;
      const prop = element.dataset.pose as keyof Pose | undefined;
      if (!prop || !(prop in this.pose)) return;
      const value = Number(element.value);
      if (!Number.isFinite(value)) return;
      this.pose[prop] = value;
      this.changed();
    });
    document.getElementById(this.panel.id)?.remove();
    document.body.appendChild(this.panel);
    this.renderInputs();
    this.surfacePlacement = new VirtualSurfacePlacement(this.world, this, this.panel);
  }

  /** Call after world.createTransformEntity(mesh), only for scene roots.
   * Children of a machine remain children of that machine as before. */
  createFactoryEntity(mesh: Object3D): ReturnType<World['createTransformEntity']> {
    return this.world.createTransformEntity(mesh, {
      parent: this.contentEntity,
    });
  }

  /** Layout's slot / collision math is defined in original factory coordinates.
   * Temporarily show full-sized original coordinates while editing Layout. */
  setLayoutEditing(enabled: boolean): void {
    if (enabled) this.surfacePlacement?.cancel();
    if (enabled) this.setFactoryGrabEnabled(false);
    this.editingLayout = enabled;
    this.panel.style.display = enabled ? 'none' : 'block';
    this.apply();
  }

  /** Surface placement operates on the shared factory root, never on individual machine positions. */
  get isEditingLayout(): boolean { return this.editingLayout; }

  getPlacementPose(): Pose { return { ...this.pose }; }

  prepareSurfacePlacement(): void {
    if (this.editingLayout) return;
    this.setFactoryGrabEnabled(false);
    this.onPlacementChanged(); // Pause production while choosing a new support surface.
  }

  confirmSurfacePose(pose: Pose): boolean {
    if (this.editingLayout || this.factoryGrabEnabled || this.grabActive) return false;
    this.pose = { ...pose };
    this.changed();
    return true;
  }

  private changed(): void {
    if (this.editingLayout) return;
    this.onPlacementChanged();
    this.apply();
    this.renderInputs();
  }

  private apply(): void {
    const p = this.editingLayout ? FULL : this.pose;
    this.root.position.set(clamp(p.x,-2.5,2.5),clamp(p.y,0.2,2.2),clamp(p.z,-5,-0.5));
    this.root.rotation.set(0, (p.yaw * Math.PI) / 180, 0);
    const scale = clamp(p.scale,0.16,1.2);
    this.root.scale.setScalar(scale);
    this.root.updateMatrixWorld(true);
    if (!this.grabActive) this.syncGrabMesh();
  }

  /** Separate XR target: grabbing this orange marker moves the FACTORY,
   * while the existing machine grips still work only in Layout Mode. */
  get grabEntityIndex(): number { return this.grabEntity.index; }
  get isFactoryGrabEnabled(): boolean { return this.factoryGrabEnabled; }

  private syncGrabMesh(): void {
    // Handle remains outside the factory hierarchy, so it can be grabbed
    // without fighting the root transform every frame.
    const p = this.editingLayout ? FULL : this.pose;
    const yaw = p.yaw * Math.PI / 180;
    const s = clamp(p.scale, 0.16, 1.2);
    const forward = 0.85 * s;
    this.grabMesh.position.set(
      p.x + Math.sin(yaw) * forward,
      p.y + 0.30 + 2.1 * s,
      p.z + Math.cos(yaw) * forward,
    );
    this.grabMesh.rotation.set(0, yaw, 0);
    this.grabMesh.updateMatrixWorld(true);
  }

  setFactoryGrabEnabled(enabled: boolean): void {
    if (enabled === this.factoryGrabEnabled) return;
    if (enabled && this.editingLayout) return;
    if (!enabled) {
      this.world.getSystem(GrabSystem)?.forceRelease(this.grabEntity);
      this.grabEntity.removeComponent(DistanceGrabbable);
      this.grabEntity.removeComponent(RayInteractable);
      this.grabActive = false;
      this.grabStartPose = null;
      this.factoryGrabEnabled = false;
      this.grabMesh.visible = false;
      this.syncGrabMesh();
    } else {
      this.factoryGrabEnabled = true;
      this.syncGrabMesh();
      this.grabMesh.visible = true;
      this.grabEntity.addComponent(RayInteractable);
      this.grabEntity.addComponent(DistanceGrabbable, {
        translate: true,
        rotate: true,
        scale: false,
        movementMode: MovementMode.MoveFromTarget,
        returnToOrigin: false,
      });
      this.onPlacementChanged(); // Stop production before relocating.
    }
    const button = this.panel.querySelector<HTMLButtonElement>('button[data-placement="grab-mode"]');
    if (button) button.textContent = enabled ? 'Disable Factory Grab (XR)' : 'Enable Factory Grab (XR)';
  }

  beginGrab(): void {
    if (!this.factoryGrabEnabled || this.editingLayout) return;
    this.grabStartPose = { ...this.pose };
    this.grabStartPosition.copy(this.grabMesh.position);
    this.grabStartYaw = this.grabMesh.rotation.y;
    this.grabActive = true;
    this.onPlacementChanged();
  }

  updateGrab(): void {
    if (!this.grabActive || !this.grabStartPose || this.editingLayout) return;
    // Handle and factory root share the same active-level coordinate system.
    const start = this.grabStartPose;
    const dx = this.grabMesh.position.x - this.grabStartPosition.x;
    const dy = this.grabMesh.position.y - this.grabStartPosition.y;
    const dz = this.grabMesh.position.z - this.grabStartPosition.z;
    const yawDelta = this.grabMesh.rotation.y - this.grabStartYaw;
    this.pose = {
      ...start,
      x: clamp(start.x + dx, -2.5, 2.5),
      y: clamp(start.y + dy, 0.2, 2.2),
      z: clamp(start.z + dz, -5.0, -0.5),
      yaw: ((start.yaw + yawDelta * 180 / Math.PI) % 360 + 360) % 360,
    };
    this.apply();
    this.renderInputs();
  }

  endGrab(): void {
    if (!this.grabActive) return;
    this.updateGrab();
    this.grabActive = false;
    this.grabStartPose = null;
    this.syncGrabMesh();
    this.renderInputs();
  }

  private renderInputs(): void {
    this.panel.querySelectorAll<HTMLInputElement>('input[data-pose]').forEach(input => {
      const key = input.dataset.pose as keyof Pose | undefined;
      if (!key) return;
      const value = this.pose[key];
      input.value = String(value);
      const output = this.panel.querySelector<HTMLOutputElement>(`output[data-value="${key}"]`);
      if (output) output.textContent = key === 'yaw' ? `${Math.round(value)}°` : value.toFixed(2);
    });
  }

  dispose(): void {
    this.surfacePlacement?.dispose();
    this.surfacePlacement = null;
    this.setFactoryGrabEnabled(false);
    this.panel.remove();
    this.grabMesh.removeFromParent();
    this.grabMesh.geometry.dispose();
    (this.grabMesh.material as MeshBasicMaterial).dispose();
    this.root.removeFromParent();
  }
}
