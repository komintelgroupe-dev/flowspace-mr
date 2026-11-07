import {
  BoxGeometry, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry,
  Raycaster, Vector2,
} from 'three';
import type { World } from '@iwsdk/core';
import type { FactoryPlacementController } from './factory-placement.js';

/**
 * V4-C.3: Desktop/IWER virtual-surface placement preview.
 * The table and floor are EXPLICIT virtual teaching surfaces; there is NO
 * physical plane detection, hit-test or spatial anchor in this version.
 */
type SurfaceId = 'table' | 'floor';
type Surface = {
  id: SurfaceId;
  name: string;
  x: number;
  z: number;
  top: number;
  width: number;
  depth: number;
  mesh: Mesh;
};

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));

export class VirtualSurfacePlacement {
  private surfaces: Surface[] = [];
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly preview: Mesh;
  private readonly controls: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private selected: Surface | null = null;
  private targetX = 0;
  private targetZ = -2.6;
  private previewScale = 0.28;
  private previewYaw = 0;
  private active = false;
  private readonly canvas: HTMLCanvasElement | null;

  constructor(private readonly world: World, private readonly placement: FactoryPlacementController, panel: HTMLElement) {
    const make = (id: SurfaceId, name: string, x: number, z: number,
      top: number, width: number, depth: number, color: number): Surface => {
      const mesh = new Mesh(
        new BoxGeometry(width, 0.04, depth),
        new MeshBasicMaterial({color, transparent: true, opacity: 0.42, depthWrite: false}),
      );
      mesh.name = `FlowSpace-Virtual-${id}-Surface`;
      mesh.position.set(x, top - 0.02, z);
      mesh.visible = false;
      this.world.createTransformEntity(mesh);
      return { id, name, x, z, top, width, depth, mesh };
    };
    this.surfaces.push(
      make('table', 'Virtual Table', -0.45, -2.75, 0.87, 2.4, 1.35, 0x3266a4),
      make('floor', 'Virtual Floor', 0, -2.75, 0.16, 7.0, 5.4, 0x3f566b),
    );

    this.preview = new Mesh(new PlaneGeometry(5.15, 1.75),
      new MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.60,
        side: DoubleSide, depthWrite: false }));
    this.preview.name = 'FlowSpace-Surface-Placement-Preview-Footprint';
    this.preview.rotation.x = -Math.PI / 2;
    this.preview.visible = false;
    this.preview.renderOrder = 90;
    this.world.createTransformEntity(this.preview);

    this.controls = document.createElement('div');
    this.controls.style.cssText = 'margin-top:11px;border-top:1px solid #506581;padding-top:9px';
    this.controls.innerHTML = `
      <strong style="display:block;margin-bottom:6px">V4-C.3 · Virtual Surface Placement</strong>
      <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px">
        <button type="button" data-surface-action="table">Select virtual table</button>
        <button type="button" data-surface-action="floor">Select virtual floor</button>
        <button type="button" data-surface-action="confirm">Confirm placement</button>
        <button type="button" data-surface-action="cancel">Cancel</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:7px">
        Move preview:
        <button type="button" data-surface-action="left">←</button>
        <button type="button" data-surface-action="right">→</button>
        <button type="button" data-surface-action="forward">↑</button>
        <button type="button" data-surface-action="back">↓</button>
      </div>
      <div data-surface-status role="status" aria-live="polite" style="font-size:11px;color:#d7e7fa">
        Select a simulated surface to preview placement.
      </div>`;
    this.controls.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      button.style.cssText = 'border:1px solid #6487b1;border-radius:6px;color:#fff;background:#123c8c;cursor:pointer;padding:5px 7px';
    });
    this.controls.addEventListener('click', this.onButton);
    panel.appendChild(this.controls);
    this.status = this.controls.querySelector<HTMLDivElement>('[data-surface-status]')!;

    this.canvas = document.querySelector<HTMLCanvasElement>('#scene-container canvas');
    this.canvas?.addEventListener('pointermove', this.onPointerMove);
    this.canvas?.addEventListener('pointerup', this.onPointerUp);
  }

  private readonly onButton = (event: MouseEvent): void => {
    const element = event.target;
    if (!(element instanceof Element)) return;
    const button = element.closest<HTMLButtonElement>('button[data-surface-action]');
    if (!button) return;
    const action = button.dataset.surfaceAction;
    if (action === 'table' || action === 'floor') {
      this.select(action);
    } else if (action === 'confirm') {
      this.confirm();
    } else if (action === 'cancel') {
      this.cancel();
    } else if (this.active && this.selected) {
      const step = 0.1;
      if (action === 'left') this.targetX -= step;
      if (action === 'right') this.targetX += step;
      if (action === 'forward') this.targetZ -= step;
      if (action === 'back') this.targetZ += step;
      this.updatePreview();
    }
  };

  private select(id: SurfaceId): void {
    if (this.placement.isEditingLayout) {
      this.message('Switch to Simulation Mode first.');
      return;
    }
    this.placement.prepareSurfacePlacement();
    this.active = true;
    this.selected = this.surfaces.find(s => s.id === id)!;
    this.surfaces.forEach(s => { s.mesh.visible = true; });
    const pose = this.placement.getPlacementPose();
    this.previewScale = id === 'table' ? 0.28 : pose.scale;
    this.previewYaw = id === 'table' ? 0 : pose.yaw;
    this.targetX = this.selected.x;
    this.targetZ = this.selected.z;
    this.updatePreview();
  }

  private isInside(surface: Surface, x: number, z: number, scale: number, yaw: number): boolean {
    const radians = yaw * Math.PI / 180;
    const c = Math.abs(Math.cos(radians));
    const s = Math.abs(Math.sin(radians));
    const footprintHalfWidth = (5.15 * c + 1.75 * s) * scale / 2;
    const footprintHalfDepth = (5.15 * s + 1.75 * c) * scale / 2;
    const margin = 0.06;
    // Also honor the existing V4-C world-position and height constraints.
    return x >= -2.5 && x <= 2.5 && z >= -5 && z <= -0.5 &&
      surface.top + 0.06 * scale >= 0.2 && surface.top + 0.06 * scale <= 2.2 &&
      Math.abs(x - surface.x) + footprintHalfWidth <= surface.width / 2 - margin &&
      Math.abs(z - surface.z) + footprintHalfDepth <= surface.depth / 2 - margin;
  }

  private updatePreview(): void {
    if (!this.selected) return;
    const ok = this.isInside(this.selected, this.targetX, this.targetZ, this.previewScale, this.previewYaw);
    const mat = this.preview.material as MeshBasicMaterial;
    mat.color.setHex(ok ? 0x22c55e : 0xef4444);
    this.preview.position.set(this.targetX, this.selected.top + 0.025, this.targetZ);
    this.preview.rotation.set(-Math.PI / 2, 0, -this.previewYaw * Math.PI / 180);
    this.preview.scale.set(this.previewScale, this.previewScale, 1);
    this.preview.visible = true;
    this.message(`${this.selected.name} · ${ok ? 'VALID (green)' : 'INVALID (red)'} · scale ${this.previewScale.toFixed(2)}. Move pointer over surface or use arrows; Confirm to place.`);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.active || !this.canvas || !this.selected) return;
    if (!this.canvas.clientWidth || !this.canvas.clientHeight) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.world.camera);
    const hit = this.raycaster.intersectObject(this.selected.mesh, false)[0];
    if (!hit) return;
    this.targetX = hit.point.x;
    this.targetZ = hit.point.z;
    this.updatePreview();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    // For mouse users, clicking the surface sets the preview point; it does
    // NOT instantly commit placement. Confirmation remains explicit.
    if (!this.active || !this.selected || event.button !== 0) return;
    this.onPointerMove(event);
  };

  private confirm(): void {
    const s = this.selected;
    if (!this.active || !s) {
      this.message('Select virtual table or floor first.');
      return;
    }
    if (!this.isInside(s, this.targetX, this.targetZ, this.previewScale, this.previewYaw)) {
      this.message('Invalid placement: move the green footprint fully inside the surface.');
      return;
    }
    const pose = {
      x: clamp(this.targetX, -2.5, 2.5),
      y: s.top + 0.06 * this.previewScale,
      z: clamp(this.targetZ, -5, -0.5),
      yaw: this.previewYaw,
      scale: this.previewScale,
    };
    if (this.placement.confirmSurfacePose(pose)) {
      this.hidePreview();
      this.message(`Confirmed on ${s.name}. This is a virtual snap, not a physical spatial anchor.`);
    } else this.message('Cannot place while Layout Mode or Factory Grab is active.');
  }

  private message(value: string): void { this.status.textContent = value; }

  private hidePreview(): void {
    this.active = false;
    this.selected = null;
    this.preview.visible = false;
    this.surfaces.forEach(s => { s.mesh.visible = false; });
  }

  cancel(): void {
    if (this.active) this.message('Placement preview cancelled; previous factory pose preserved.');
    this.hidePreview();
  }

  dispose(): void {
    this.canvas?.removeEventListener('pointermove', this.onPointerMove);
    this.canvas?.removeEventListener('pointerup', this.onPointerUp);
    this.controls.removeEventListener('click', this.onButton);
    this.controls.remove();
    for (const surface of this.surfaces) {
      surface.mesh.removeFromParent();
      surface.mesh.geometry.dispose();
      (surface.mesh.material as MeshBasicMaterial).dispose();
    }
    this.preview.removeFromParent();
    this.preview.geometry.dispose();
    (this.preview.material as MeshBasicMaterial).dispose();
  }
}
