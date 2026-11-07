/**
 * FlowSpace MR V5.2 — local production order ↔ XR simulator bridge.
 * The SQLite backend is authoritative for material and product stock.
 * No stock movements are posted until the user explicitly confirms completion.
 */

const API_URL = 'http://127.0.0.1:8001';

type ProductionOrder = {
  id: number;
  product_id: number;
  quantity: number;
  status: 'draft' | 'completed' | 'cancelled';
};

type Product = {
  id: number;
  sku: string;
  name: string;
  finished_stock: number;
};

type Material = {
  id: number;
  sku: string;
  name: string;
  unit: string;
  stock: number;
};

type Requirements = {
  bom_configured: boolean;
  can_complete: boolean;
  requirements: Array<{
    name: string;
    unit: string;
    required: number;
    available: number;
    sufficient: boolean;
  }>;
};

type SessionPhase = 'simulating' | 'ready' | 'posting' | 'posted';

type Session = {
  order: ProductionOrder;
  phase: SessionPhase;
  completed: number;
};

type ProductionSyncHooks = {
  startSimulation: (order: ProductionOrder) => void;
  stopSimulation: () => void;
  abandonSimulation: () => void;
};

/** Read-only view of the V5.2 source of truth for the spatial XR panel. */
export type SpatialProductionSnapshot = {
  online: boolean;
  busy: boolean;
  message: string;
  draftCount: number;
  selectedOrderId: number | null;
  selected: { id: number; name: string; quantity: number } | null;
  session: {
    id: number; name: string; quantity: number; completed: number;
    phase: 'simulating' | 'ready' | 'posting' | 'posted';
  } | null;
  materials: Array<{ name: string; stock: number; unit: string }>;
};

export class ProductionSyncPanel {
  private root: HTMLDetailsElement | null = null;
  private orders: ProductionOrder[] = [];
  private products: Product[] = [];
  private materials: Material[] = [];
  private session: Session | null = null;
  private selectedOrderId: number | null = null;
  private online = false;
  private busy = false;
  private disposed = false;
  private message = 'Connect to the local production API on port 8001.';

  constructor(private readonly hooks: ProductionSyncHooks) {}

  // No new API requests here: always read the current V5.2 state.
  getSpatialSnapshot(): SpatialProductionSnapshot {
    const drafts = this.orders.filter(o => o.status === 'draft');
    const selected = drafts.find(o => o.id === this.selectedOrderId);
    const nameOf = (productId: number): string =>
      this.products.find(p => p.id === productId)?.name ?? 'Unknown product';
    const currentSession = this.session;
    const session = currentSession && currentSession.phase !== 'posted' ? currentSession : null;
    return {
      online: this.online,
      busy: this.busy,
      message: this.message,
      draftCount: drafts.length,
      selectedOrderId: selected?.id ?? null,
      selected: selected
        ? { id: selected.id, name: nameOf(selected.product_id), quantity: selected.quantity }
        : null,
      session: session ? {
        id: session.order.id,
        name: nameOf(session.order.product_id),
        quantity: session.order.quantity,
        completed: session.completed,
        phase: session.phase,
      } : null,
      materials: this.materials.map(m => ({ name: m.name, stock: m.stock, unit: m.unit })),
    };
  }

  /** These public XR actions reuse existing validation and posting logic. */
  refreshForXR(): Promise<void> { return this.refresh(); }
  startForXR(): Promise<void> { return this.start(); }
  confirmForXR(): Promise<void> { return this.post(); }

  selectNextDraftForXR(): void {
    if (this.busy || this.hasActiveOrder()) return;
    const drafts = this.orders.filter(o => o.status === 'draft');
    if (!drafts.length) {
      this.message = 'No draft production orders available.';
      this.render();
      return;
    }
    const index = drafts.findIndex(o => o.id === this.selectedOrderId);
    this.selectedOrderId = drafts[(index + 1) % drafts.length].id;
    this.render();
  }

  hasActiveOrder(): boolean {
    return this.session !== null &&
      this.session.phase !== 'posted';
  }

  isAwaitingPost(): boolean {
    return this.session?.phase === 'ready' || this.session?.phase === 'posting';
  }

  mount(dashboard: HTMLElement): void {
    if (this.root) return;
    const root = document.createElement('details');
    root.id = 'flowspace-production-sync';
    root.style.cssText = [
      'margin:10px 0', 'padding:10px', 'border:1px solid #FF6B00',
      'border-radius:9px', 'background:#10233c', 'color:#eaf2ff',
      'font:12px/1.45 Arial,sans-serif'
    ].join(';');
    root.innerHTML = `
      <summary style="cursor:pointer;font-weight:700;color:#ffc49f">
        🗄 V5.2 — Database Production Link
        <span data-v52="connection" style="font-weight:400"></span>
      </summary>
      <div style="margin-top:10px;display:grid;gap:7px">
        <p data-v52="message" style="margin:0;white-space:pre-wrap"></p>
        <button type="button" data-v52-action="refresh">Refresh orders / stock</button>
        <label for="flowspace-v52-order">Draft production order</label>
        <select id="flowspace-v52-order" data-v52="orders"
          style="width:100%;padding:7px;background:#263d60;color:white;border:1px solid #6582aa;border-radius:5px"></select>
        <div data-v52="requirements" style="white-space:pre-wrap;opacity:.9"></div>
        <div data-v52="inventory" style="white-space:pre-wrap;opacity:.82"></div>
        <button type="button" data-v52-action="start" style="background:#123C8C;color:white">Simulate selected order</button>
        <div data-v52="progress" style="font-weight:700;color:#a5f5c5"></div>
        <button type="button" data-v52-action="post" style="background:#FF6B00;color:#14243a;font-weight:700">Confirm & post completed order</button>
        <button type="button" data-v52-action="abandon" style="background:#394c69;color:white">Abandon local simulation (no DB changes)</button>
        <small style="opacity:.73">Local development only. The 3D scene simulates batches; SQLite records inventory only after confirmation. Progress in an unfinished run is not saved across reloads.</small>
      </div>
    `;
    root.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      button.style.padding = '7px';
      button.style.borderRadius = '5px';
      button.style.border = '1px solid #6385b9';
      button.style.cursor = 'pointer';
    });
    const anchor = dashboard.querySelector('#flow-topstats');
    if (anchor) anchor.after(root);
    else dashboard.appendChild(root);
    this.root = root;
    root.addEventListener('click', this.handleClick);
    root.querySelector<HTMLSelectElement>('[data-v52="orders"]')?.addEventListener('change', this.handleSelection);
    this.render();
    void this.refresh();
  }

  /** Cheap per-frame observation: only updates the DOM when completed count changes. */
  onProgress(completed: number): void {
    const session = this.session;
    if (!session || session.phase !== 'simulating') return;
    if (session.completed === completed) return;
    session.completed = completed;
    if (completed >= session.order.quantity) {
      this.hooks.stopSimulation();
      session.phase = 'ready';
      this.message = `Order #${session.order.id} simulated ${completed}/${session.order.quantity} batches. Confirm to post stock movements to SQLite.`;
    }
    this.render();
  }

  private readonly handleSelection = (event: Event): void => {
    const select = event.currentTarget as HTMLSelectElement;
    this.selectedOrderId = select.value ? Number(select.value) : null;
    this.render();
  };

  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button[data-v52-action]');
    if (!button || !this.root?.contains(button) || this.busy) return;
    const action = button.dataset.v52Action;
    if (action === 'refresh') void this.refresh();
    if (action === 'start') void this.start();
    if (action === 'post') void this.post();
    if (action === 'abandon') this.abandon();
  };

  private async request<T>(path: string, method: 'GET' | 'POST' = 'GET'): Promise<T> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(API_URL + path, {
        method,
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        if (payload && typeof payload === 'object' && 'detail' in payload) {
          detail = JSON.stringify((payload as { detail: unknown }).detail);
        }
        throw new Error(`${detail} (${path})`);
      }
      return payload as T;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private async refresh(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.message = 'Checking API and reading SQLite-backed orders...';
    this.render();
    try {
      const [health, orders, products, materials] = await Promise.all([
        this.request<{ status: string }>('/health'),
        this.request<ProductionOrder[]>('/api/orders'),
        this.request<Product[]>('/api/products'),
        this.request<Material[]>('/api/materials'),
      ]);
      if (this.disposed) return;
      this.online = health.status === 'ok';
      this.orders = orders;
      this.products = products;
      this.materials = materials;
      const drafts = orders.filter(o => o.status === 'draft');
      if (!drafts.some(o => o.id === this.selectedOrderId)) {
        this.selectedOrderId = drafts[0]?.id ?? null;
      }
      this.message = `Connected. ${drafts.length} draft order(s) available.`;
    } catch (error) {
      this.online = false;
      this.message = `API unavailable: ${String(error)}. Start FastAPI on 127.0.0.1:8001 and retry.`;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async start(): Promise<void> {
    if (this.busy || !this.online || this.hasActiveOrder()) return;
    const order = this.orders.find(o => o.id === this.selectedOrderId && o.status === 'draft');
    if (!order) return;
    this.busy = true;
    this.message = `Checking BOM and current stock for order #${order.id}...`;
    this.render();
    try {
      const requirement = await this.request<Requirements>(`/api/orders/${order.id}/requirements`);
      if (!requirement.bom_configured || !requirement.can_complete) {
        const lacking = requirement.requirements.filter(r => !r.sufficient).map(r => r.name);
        throw new Error(lacking.length
          ? `Not enough materials: ${lacking.join(', ')}`
          : 'Order is not ready: check its BOM, draft status, and stock.');
      }
      // This callback resets only the existing, local 3D demo counters.
      this.hooks.startSimulation(order);
      this.session = { order, phase: 'simulating', completed: 0 };
      this.message = `Order #${order.id} is running in the virtual factory. Do not reload before finishing.`;
      if (this.root) this.root.open = true;
    } catch (error) {
      this.message = `Cannot start: ${String(error)}`;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async post(): Promise<void> {
    const session = this.session;
    if (this.busy || !session || session.phase !== 'ready') return;
    this.busy = true;
    session.phase = 'posting';
    this.message = 'Posting one atomic completion transaction to SQLite...';
    this.render();
    try {
      // Recheck right before posting: backend still performs its own atomic validation.
      const latest = await this.request<Requirements>(`/api/orders/${session.order.id}/requirements`);
      if (!latest.can_complete) throw new Error('BOM, stock or order status changed. Check the production panel.');
      await this.request<ProductionOrder>(`/api/orders/${session.order.id}/complete`, 'POST');
      session.phase = 'posted';
      this.message = `Order #${session.order.id} completed in SQLite. Material stock decreased once and finished stock increased once.`;
      await this.refreshAfterPosting();
    } catch (error) {
      // A lost network response could follow a successful DB commit. Reconcile status.
      try {
        const orders = await this.request<ProductionOrder[]>('/api/orders');
        if (orders.some(o => o.id === session.order.id && o.status === 'completed')) {
          session.phase = 'posted';
          this.message = `Order #${session.order.id} is already completed in SQLite. No duplicate inventory movement was recorded.`;
          this.orders = orders;
          await this.refreshAfterPosting();
          return;
        }
      } catch { /* Keep draft session available for a deliberate retry. */ }
      session.phase = 'ready';
      this.message = `Posting failed; no local retry occurred automatically. ${String(error)}. Refresh stock in /panel and retry only if order is still draft.`;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async refreshAfterPosting(): Promise<void> {
    // Do not call refresh() while busy; read only the post-commit snapshots.
    try {
      [this.orders, this.products, this.materials] = await Promise.all([
        this.request<ProductionOrder[]>('/api/orders'),
        this.request<Product[]>('/api/products'),
        this.request<Material[]>('/api/materials'),
      ]);
      const drafts = this.orders.filter(o => o.status === 'draft');
      this.selectedOrderId = drafts[0]?.id ?? null;
      this.online = true;
    } catch {
      this.message += ' (Stock refresh unavailable; use Refresh button.)';
    }
  }

  private abandon(): void {
    if (!this.hasActiveOrder() || this.busy) return;
    if (!window.confirm('Abandon this virtual run? No inventory will change in SQLite.')) return;
    this.hooks.stopSimulation();
    this.hooks.abandonSimulation();
    this.session = null;
    this.message = 'Virtual run abandoned; order remains draft in the database.';
    this.render();
  }

  private view(selector: string): HTMLElement | null {
    return this.root?.querySelector<HTMLElement>(`[data-v52="${selector}"]`) ?? null;
  }

  private render(): void {
    if (!this.root || this.disposed) return;
    const connection = this.view('connection');
    if (connection) connection.textContent = this.online ? '● Online' : '● Offline';
    const status = this.view('message');
    if (status) status.textContent = this.message;

    const select = this.root.querySelector<HTMLSelectElement>('[data-v52="orders"]');
    if (select) {
      // Avoid destroying the select while the user is interacting with it.
      const drafts = this.orders.filter(o => o.status === 'draft');
      const ids = drafts.map(o => String(o.id)).join(',');
      if (select.dataset.orderIds !== ids) {
        select.replaceChildren();
        for (const order of drafts) {
          const product = this.products.find(p => p.id === order.product_id);
          const option = document.createElement('option');
          option.value = String(order.id);
          option.textContent = `#${order.id} ${product?.name ?? 'Product'} × ${order.quantity}`;
          select.appendChild(option);
        }
        select.dataset.orderIds = ids;
      }
      if (this.selectedOrderId !== null) select.value = String(this.selectedOrderId);
      select.disabled = this.busy || this.hasActiveOrder();
    }

    const inventory = this.view('inventory');
    if (inventory) {
      inventory.textContent = this.materials.length
        ? `Database materials: ${this.materials.map(m => `${m.name}: ${m.stock} ${m.unit}`).join(' | ')}`
        : 'No raw materials registered yet.';
    }
    const req = this.view('requirements');
    if (req) req.textContent = this.online
      ? 'Before running, BOM and sufficient stock are checked by FastAPI.'
      : 'Backend is offline. The XR simulator continues to work independently.';

    const progress = this.view('progress');
    if (progress) progress.textContent = this.session
      ? `Order #${this.session.order.id}: ${this.session.completed}/${this.session.order.quantity} batches — ${this.session.phase.toUpperCase()}`
      : 'No linked simulation currently active.';

    const enable = (action: string, isEnabled: boolean) => {
      const button = this.root?.querySelector<HTMLButtonElement>(`[data-v52-action="${action}"]`);
      if (button) button.disabled = !isEnabled;
    };
    const active = this.hasActiveOrder();
    enable('refresh', !this.busy);
    enable('start', !this.busy && this.online && !active && this.selectedOrderId !== null);
    enable('post', !this.busy && this.session?.phase === 'ready');
    enable('abandon', !this.busy && active && this.session?.phase !== 'posting');
  }

  dispose(): void {
    this.disposed = true;
    this.root?.removeEventListener('click', this.handleClick);
    this.root?.querySelector<HTMLSelectElement>('[data-v52="orders"]')?.removeEventListener('change', this.handleSelection);
    this.root?.remove();
    this.root = null;
  }
}
