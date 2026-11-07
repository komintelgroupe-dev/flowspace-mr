import { parseFactoryLayoutSnapshot } from './smart-factory-layout.js';
import type { FactoryLayoutSnapshot } from './smart-factory-layout.js';

const STORAGE_KEY = 'flowspace-mr.v4b4.layouts.v1';
const MAX_LAYOUTS = 20;
const MAX_FILE_BYTES = 1024 * 1024;

type StoredPreset = {
  id: string;
  name: string;
  createdAt: string;
  layout: FactoryLayoutSnapshot;
};

type PresetHandlers = {
  capture: () => FactoryLayoutSnapshot | null;
  apply: (layout: FactoryLayoutSnapshot) => boolean;
  reset: () => void;
};

/** Save and load only the physical layout, never inventory or simulation progress. */
export class FactoryLayoutPresetsPanel {
  private root: HTMLDivElement;
  private nameInput: HTMLInputElement;
  private selection: HTMLSelectElement;
  private fileInput: HTMLInputElement;
  private status: HTMLElement;
  private visible = false;
  private lastMessageWasError = false;

  constructor(private handlers: PresetHandlers) {
    document.getElementById('flowspace-layout-presets')?.remove();
    const root = document.createElement('div');
    root.id = 'flowspace-layout-presets';
    root.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:14px', 'z-index:10007',
      'width:282px', 'max-width:calc(100vw - 28px)',
      'box-sizing:border-box', 'background:rgba(14,26,47,.97)',
      'color:white', 'padding:12px', 'border-radius:11px',
      'border:1px solid #ff6b00', 'box-shadow:0 12px 32px #0005',
      'font:12px/1.4 Arial,sans-serif', 'display:none',
    ].join(';');

    const title = document.createElement('strong');
    title.textContent = '💾 Save & Load Factory Layout';
    title.style.cssText = 'display:block;font-size:14px;margin-bottom:7px';

    const name = document.createElement('input');
    name.type = 'text';
    name.placeholder = 'Layout name (e.g. Factory A)';
    name.maxLength = 50;
    name.setAttribute('aria-label', 'New factory layout name');
    name.style.cssText = 'box-sizing:border-box;width:100%;padding:8px;margin-bottom:7px;border-radius:6px;border:1px solid #547095;background:#202f49;color:white';
    this.nameInput = name;

    const selection = document.createElement('select');
    selection.setAttribute('aria-label', 'Saved layouts');
    selection.style.cssText = 'box-sizing:border-box;width:100%;padding:8px;margin-bottom:7px;border-radius:6px;border:1px solid #547095;background:#202f49;color:white';
    this.selection = selection;

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap';
    const buttons: Array<[string, string]> = [
      ['save', 'Save current'], ['load', 'Load selected'],
      ['delete', 'Delete'], ['export', 'Export JSON'],
      ['import', 'Import JSON'], ['reset', 'Reset layout'],
    ];
    for (const [action, label] of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.layoutAction = action;
      b.textContent = label;
      b.style.cssText = 'cursor:pointer;padding:7px 8px;border:1px solid #547095;border-radius:6px;background:#123c8c;color:white';
      if (action === 'save') b.style.background = '#b84e07';
      actions.appendChild(b);
    }

    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'min-height:18px;color:#c5d8f1;font-size:11px;margin-top:7px';
    this.status = status;

    const info = document.createElement('div');
    info.textContent = 'Stored in this browser only. Export JSON for backup or transfer. Production counters are not saved.';
    info.style.cssText = 'font-size:10px;opacity:.7;margin-top:5px';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.hidden = true;
    this.fileInput = fileInput;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) void this.importFile(file);
      fileInput.value = '';
    });

    root.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest<HTMLButtonElement>('button[data-layout-action]');
      if (!button || !root.contains(button) || !this.visible) return;
      switch (button.dataset.layoutAction) {
        case 'save': this.saveCurrent(); break;
        case 'load': this.loadSelected(); break;
        case 'delete': this.deleteSelected(); break;
        case 'export': this.exportCurrent(); break;
        case 'import': this.fileInput.click(); break;
        case 'reset':
          this.handlers.reset();
          this.message('Original factory layout restored.');
          break;
      }
    });

    root.append(title, name, selection, actions, status, info, fileInput);
    document.body.appendChild(root);
    this.root = root;
    this.refreshList();
  }

  show(visible: boolean): void {
    this.visible = visible;
    this.root.style.display = visible ? 'block' : 'none';
    if (visible) this.refreshList();
  }

  private message(text: string, isError = false): void {
    this.lastMessageWasError = isError;
    this.status.textContent = text;
    this.status.style.color = isError ? '#ffb2a5' : '#9bf6b7';
  }

  private readPresets(): StoredPreset[] | null {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (!stored) return [];
      const raw: unknown = JSON.parse(stored);
      if (!Array.isArray(raw)) return [];
      return raw.slice(0, MAX_LAYOUTS).flatMap((entry: unknown) => {
        if (entry === null || typeof entry !== 'object') return [];
        const e = entry as Record<string, unknown>;
        const layout = parseFactoryLayoutSnapshot(e.layout);
        if (typeof e.id !== 'string' || typeof e.name !== 'string' ||
            typeof e.createdAt !== 'string' || !layout) return [];
        return [{
          id: e.id.slice(0, 100),
          name: e.name.slice(0, 50),
          createdAt: e.createdAt,
          layout,
        }];
      });
    } catch {
      this.message('Browser storage is unavailable. Use Export JSON instead.', true);
      return null;
    }
  }

  private writePresets(presets: StoredPreset[]): boolean {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
      return true;
    } catch {
      this.message('Cannot save to browser storage. Try Export JSON.', true);
      return false;
    }
  }

  private refreshList(selectId?: string): void {
    const previousId = selectId ?? this.selection.value;
    const presets = this.readPresets();
    if (presets === null) return;
    this.selection.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = presets.length ? 'Choose a saved layout' : 'No saved layouts';
    this.selection.appendChild(empty);
    for (const item of presets) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      this.selection.appendChild(option);
    }
    if (previousId && presets.some(p => p.id === previousId)) this.selection.value = previousId;
  }

  private saveCurrent(): void {
    const name = this.nameInput.value.trim();
    if (!name) { this.message('Enter a layout name first.', true); return; }
    const layout = this.handlers.capture();
    if (!layout) {
      this.message('Snap/release machines into valid slots before saving.', true);
      return;
    }
    const presets = this.readPresets();
    if (presets === null) return;
    if (presets.length >= MAX_LAYOUTS) {
      this.message(`Maximum ${MAX_LAYOUTS} layouts. Delete one first.`, true);
      return;
    }
    if (presets.some(p => p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      this.message('This name already exists. Use another name.', true);
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    presets.push({ id, name, createdAt: new Date().toISOString(), layout });
    if (!this.writePresets(presets)) return;
    this.refreshList(id);
    this.message(`Saved: ${name}`);
  }

  private loadSelected(): void {
    const presets = this.readPresets();
    if (!presets) return;
    const chosen = presets.find(p => p.id === this.selection.value);
    if (!chosen) { this.message('Select a saved layout.', true); return; }
    if (!this.handlers.apply(chosen.layout)) {
      this.message('Cannot apply: machine overlap or invalid positions.', true);
      return;
    }
    this.message(`Loaded: ${chosen.name}`);
  }

  private deleteSelected(): void {
    const presets = this.readPresets();
    if (!presets) return;
    const chosen = presets.find(p => p.id === this.selection.value);
    if (!chosen) { this.message('Select a saved layout.', true); return; }
    if (!window.confirm(`Delete saved layout "${chosen.name}"?`)) return;
    if (!this.writePresets(presets.filter(p => p.id !== chosen.id))) return;
    this.refreshList();
    this.message('Saved layout deleted. Current scene unchanged.');
  }

  private exportCurrent(): void {
    const layout = this.handlers.capture();
    if (!layout) {
      this.message('Snap/release machines into valid slots before exporting.', true);
      return;
    }
    const filename = `flowspace-layout-${new Date().toISOString().slice(0, 10)}.json`;
    const data = {
      fileType: 'FlowSpaceMRLayout', version: 1,
      exportedAt: new Date().toISOString(),
      name: this.nameInput.value.trim().slice(0, 50) || 'Exported factory layout',
      layout,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.message('Current layout exported to JSON.');
  }

  private async importFile(file: File): Promise<void> {
    if (file.size > MAX_FILE_BYTES) {
      this.message('JSON file is too large.', true);
      return;
    }
    try {
      const raw: unknown = JSON.parse(await file.text());
      if (raw === null || typeof raw !== 'object') throw new Error('not-object');
      const record = raw as Record<string, unknown>;
      if (record.fileType !== 'FlowSpaceMRLayout' || record.version !== 1) {
        throw new Error('unknown-file-type');
      }
      const layout = parseFactoryLayoutSnapshot(record.layout);
      if (!layout) throw new Error('invalid-layout');
      const presets = this.readPresets();
      if (!presets) return;
      if (presets.length >= MAX_LAYOUTS) { this.message('Saved layout limit reached.', true); return; }
      const rawName = typeof record.name === 'string' ? record.name.trim() : '';
      const baseName = (rawName || 'Imported layout').slice(0, 45);
      let name = baseName;
      let suffix = 2;
      while (presets.some(p => p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        name = `${baseName.slice(0, 45)} (${suffix++})`;
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      presets.push({ id, name, createdAt: new Date().toISOString(), layout });
      if (!this.writePresets(presets)) return;
      this.refreshList(id);
      this.message(`Imported: ${name}. Click Load selected to apply.`);
    } catch {
      this.message('Invalid FlowSpace layout JSON file.', true);
    }
  }

  /** XR save: automatically named, using the exact same validation/storage as Save Current. */
  saveForXR(): { ok: boolean; message: string } {
    if (!this.visible) return { ok: false, message: 'Switch to Layout Mode first' };
    const presets = this.readPresets();
    if (presets === null) return { ok: false, message: this.status.textContent || 'Storage unavailable' };
    let count = 1;
    while (presets.some(p => p.name.toLowerCase() === `xr layout ${count}`)) count++;
    this.nameInput.value = `XR Layout ${count}`;
    this.saveCurrent();
    return { ok: !this.lastMessageWasError, message: this.status.textContent || 'Save failed' };
  }

  /** XR cycle: choose a preset with no 2D drop-down or virtual keyboard. */
  nextForXR(): { ok: boolean; message: string } {
    if (!this.visible) return { ok: false, message: 'Switch to Layout Mode first' };
    const presets = this.readPresets();
    if (!presets) return { ok: false, message: this.status.textContent || 'Storage unavailable' };
    if (presets.length === 0) return { ok: false, message: 'No saved layouts yet' };
    const current = presets.findIndex(p => p.id === this.selection.value);
    const next = presets[(current + 1) % presets.length];
    this.refreshList();
    this.selection.value = next.id;
    this.message(`Selected: ${next.name}`);
    return { ok: true, message: `Selected: ${next.name}` };
  }

  /** XR load goes through the same atomic snapshot validation as the desktop UI. */
  loadForXR(): { ok: boolean; message: string } {
    if (!this.visible) return { ok: false, message: 'Switch to Layout Mode first' };
    if (!this.selection.value) return { ok: false, message: 'Press NEXT to choose a saved layout' };
    this.loadSelected();
    return { ok: !this.lastMessageWasError, message: this.status.textContent || 'Load failed' };
  }

  dispose(): void {
    this.root.remove();
  }
}
