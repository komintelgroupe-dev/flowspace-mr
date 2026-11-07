/**
 * FlowSpace MR V5.3 — XR Production Dashboard.
 * Reuses the validated V5.2 order controller (no direct stock writes).
 * All buttons are IWSDK Ray/Poke interactables and dispatch via FactorySystem.
 */
import { Hovered, PokeInteractable, RayInteractable, type World } from '@iwsdk/core';
import {
  BoxGeometry, CanvasTexture, DoubleSide, Group, Mesh, MeshBasicMaterial,
  PlaneGeometry, SRGBColorSpace, type Material,
} from 'three';
import type { SpatialProductionSnapshot } from './production-sync.js';

type DashboardAction = 'refresh' | 'next' | 'start' | 'confirm';
type DashboardHandlers = {
  snapshot: () => SpatialProductionSnapshot;
  refresh: () => void;
  selectNext: () => void;
  start: () => void;
  confirm: () => void;
};
type ButtonInfo = {
  entity: ReturnType<World['createTransformEntity']>;
  mesh: Mesh;
  action: DashboardAction;
  texture: CanvasTexture;
  lastKey: string;
};

const NAVY = '#14243A';
const BLUE = '#123C8C';
const ORANGE = '#FF6B00';
const ACTIONS: DashboardAction[] = ['refresh', 'next', 'start', 'confirm'];
const LABELS: Record<DashboardAction, string> = {
  refresh: 'REFRESH FROM DATABASE',
  next: 'NEXT DRAFT ORDER',
  start: 'START SIMULATION',
  confirm: 'CONFIRM COMPLETION',
};

export class SpatialProductionDashboard {
  private readonly rootEntity: ReturnType<World['createTransformEntity']>;
  private readonly buttons: ButtonInfo[] = [];
  private readonly byEntity = new Map<number, DashboardAction>();
  private readonly meshes: Mesh[] = [];
  private readonly textures: CanvasTexture[] = [];
  private readonly panelTexture: CanvasTexture;
  private readonly panelCanvas: HTMLCanvasElement;
  private readonly panelContext: CanvasRenderingContext2D;
  private lastPanelKey = '';
  private disposed = false;
  private lastPress = -1;
  private lastPressAt = 0;
  private confirmUntil = 0;
  private notice = 'Select a draft order to start.';

  constructor(private readonly world: World, private readonly handlers: DashboardHandlers) {
    const root = new Group();
    root.name = 'FlowSpace-V5.3-Spatial-Production';
    // Symmetric to existing left XR factory menu, avoiding the center workspace.
    root.position.set(2.45, 2.42, -1.30);
    root.scale.setScalar(0.82);
    root.rotation.y = -0.15;
    this.rootEntity = world.createTransformEntity(root);

    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 1200;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('V5.3: 2D canvas unavailable');
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const panel = new Mesh(new PlaneGeometry(1.96, 2.56), new MeshBasicMaterial({
      map: texture, side: DoubleSide,
    }));
    panel.position.z = -0.055;
    root.add(panel);
    this.meshes.push(panel);
    this.textures.push(texture);
    this.panelCanvas = canvas;
    this.panelContext = context;
    this.panelTexture = texture;

    const buttonY = [-0.50, -0.73, -0.96, -1.19];
    for (const [index, action] of ACTIONS.entries()) {
      const bc = document.createElement('canvas');
      bc.width = 1024;
      bc.height = 144;
      const bt = new CanvasTexture(bc);
      bt.colorSpace = SRGBColorSpace;
      this.textures.push(bt);
      const front = new MeshBasicMaterial({ map: bt });
      const side = new MeshBasicMaterial({ color: 0x284366 });
      const materials: Material[] = [side, side, side, side, front, side];
      const mesh = new Mesh(new BoxGeometry(1.76, 0.175, 0.035), materials);
      mesh.position.set(0, buttonY[index], 0.03);
      this.meshes.push(mesh);
      const entity = world.createTransformEntity(mesh, { parent: this.rootEntity });
      entity.addComponent(RayInteractable);
      entity.addComponent(PokeInteractable);
      this.byEntity.set(entity.index, action);
      this.buttons.push({ entity, mesh, action, texture: bt, lastKey: '' });
    }
    this.sync();
  }

  isHoveringButton(): boolean {
    return !this.disposed && this.buttons.some(b => b.entity.hasComponent(Hovered));
  }

  /** True if the button press was handled (including blocked/duplicate presses). */
  handlePressed(entityIndex: number): boolean {
    if (this.disposed) return false;
    const action = this.byEntity.get(entityIndex);
    if (!action) return false;
    const now = performance.now();
    if (this.lastPress === entityIndex && now - this.lastPressAt < 300) return true;
    this.lastPress = entityIndex;
    this.lastPressAt = now;
    const s = this.handlers.snapshot();
    if (s.busy) {
      this.notice = 'Please finish the current operation.';
      return true;
    }
    if (action === 'refresh') {
      this.confirmUntil = 0;
      this.notice = 'Refreshing orders and inventory...';
      this.handlers.refresh();
    } else if (action === 'next') {
      this.confirmUntil = 0;
      if (s.session) this.notice = 'Finish the current order first.';
      else {
        this.handlers.selectNext();
        this.notice = 'Selected next draft order.';
      }
    } else if (action === 'start') {
      this.confirmUntil = 0;
      if (!s.online || s.session || s.selectedOrderId === null) {
        this.notice = 'Select a draft order and connect to API.';
      } else {
        this.notice = 'Validating BOM and material stock...';
        this.handlers.start();
      }
    } else if (action === 'confirm') {
      if (s.session?.phase !== 'ready') {
        this.confirmUntil = 0;
        this.notice = 'Complete simulation before posting stock.';
      } else if (now > this.confirmUntil) {
        this.confirmUntil = now + 4500;
        this.notice = 'PRESS CONFIRM AGAIN within 4.5 seconds.';
      } else {
        this.confirmUntil = 0;
        this.notice = 'Posting completion via V5.2 safeguards...';
        this.handlers.confirm();
      }
    }
    this.sync();
    return true;
  }

  /** Called every ~0.2s. Canvas textures update only when their contents change. */
  sync(stages: readonly string[] = []): void {
    if (this.disposed) return;
    const s = this.handlers.snapshot();
    const order = s.session ?? s.selected;
    const phase = s.session?.phase.toUpperCase() ?? (s.selected ? 'DRAFT' : 'NONE');
    const progress = s.session ? `${s.session.completed}/${s.session.quantity}` : '0/0';
    const inventory = s.materials.slice(0, 3).map(m => `${m.name}: ${m.stock} ${m.unit}`);
    const lines = [
      s.online ? '● API ONLINE (SQLite)' : '● API OFFLINE',
      `Draft orders: ${s.draftCount}`,
      order ? `Order #${order.id} — ${order.name}` : 'No order selected',
      order ? `Quantity: ${order.quantity}    Status: ${phase}` : 'Connect to start an order',
      `Simulated output: ${progress} batches`,
      ...stages.slice(0, 3).map((v, i) => `${['Mixing', 'Processing', 'Packaging'][i]}: ${v}`),
      'RAW MATERIAL STOCK (DATABASE)',
      ...(inventory.length ? inventory : ['No materials available']),
      'Stock is posted ONLY after confirmation.',
      this.confirmUntil > performance.now() ? this.notice : s.message,
    ];
    const key = JSON.stringify(lines);
    if (key !== this.lastPanelKey) {
      this.lastPanelKey = key;
      const ctx = this.panelContext;
      const w = this.panelCanvas.width;
      ctx.fillStyle = NAVY;
      ctx.fillRect(0, 0, w, this.panelCanvas.height);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 47px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('FLOWSPACE  |  PRODUCTION', w / 2, 65, 940);
      ctx.fillStyle = ORANGE;
      ctx.fillRect(34, 86, w - 68, 5);
      ctx.textAlign = 'left';
      let y = 150;
      for (const [i, raw] of lines.entries()) {
        if (i === 7) { ctx.fillStyle = '#A8C7EF'; ctx.font = 'bold 30px Arial'; }
        else if (i === 0) { ctx.fillStyle = s.online ? '#90F1BD' : '#FFB0A1'; ctx.font = 'bold 36px Arial'; }
        else if (i === lines.length - 1) { ctx.fillStyle = '#FFCF9C'; ctx.font = '28px Arial'; }
        else { ctx.fillStyle = '#F2F6FF'; ctx.font = '30px Arial'; }
        const line = raw.length > 57 ? `${raw.slice(0, 54)}...` : raw;
        ctx.fillText(line, 40, y, w - 80);
        y += i === 6 ? 64 : 48;
      }
      this.panelTexture.needsUpdate = true;
    }

    for (const b of this.buttons) {
      const enabled = b.action === 'refresh' ? !s.busy :
        b.action === 'next' ? !s.busy && !s.session && s.draftCount > 0 :
        b.action === 'start' ? !s.busy && s.online && !s.session && s.selectedOrderId !== null :
        !s.busy && s.session?.phase === 'ready';
      const hover = b.entity.hasComponent(Hovered);
      const key = `${enabled}:${hover}:${this.confirmUntil > performance.now() && b.action === 'confirm'}`;
      if (b.lastKey === key) continue;
      b.lastKey = key;
      const ctx = (b.texture.image as HTMLCanvasElement).getContext('2d');
      if (!ctx) continue;
      ctx.fillStyle = !enabled ? '#4B5360' : hover ? '#FF8739' : b.action === 'confirm' ? ORANGE : BLUE;
      ctx.fillRect(0, 0, 1024, 144);
      ctx.strokeStyle = hover ? '#FFFFFF' : '#648DC2';
      ctx.lineWidth = 6;
      ctx.strokeRect(4, 4, 1016, 136);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 48px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = b.action === 'confirm' && this.confirmUntil > performance.now()
        ? 'CONFIRM AGAIN TO POST' : LABELS[b.action];
      ctx.fillText(label, 512, 76, 970);
      b.texture.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.byEntity.clear();
    for (const b of this.buttons) b.entity.dispose();
    this.buttons.length = 0;
    this.rootEntity.dispose();
    const materials = new Set<Material>();
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of list) materials.add(m);
    }
    materials.forEach(m => m.dispose());
    for (const t of this.textures) t.dispose();
  }
}
