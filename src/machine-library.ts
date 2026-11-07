import type { SmartFactoryLayout } from './smart-factory-layout.js';

const MACHINE_NAMES = ['Mixing', 'Processing', 'Packaging'] as const;
const PALETTE = ['#123c8c', '#ff6b00', '#123c8c'] as const;

type LibraryHandlers = {
  onRemove: (machine: number) => void;
  onPlace: (machine: number, slot: number) => void;
  onReset: () => void;
};

/** Desktop-only palette. It never creates new production stages or paid users. */
export class MachineLibraryPanel {
  private root: HTMLDivElement;
  private selectedMachine: number | null = null;
  private enabled = false;
  private draggingMachine: number | null = null;

  private readonly onSceneDragOver = (event: DragEvent): void => {
    if (!this.enabled || this.draggingMachine === null || !(event.target instanceof Node)) return;
    const scene = document.getElementById('scene-container');
    if (!scene?.contains(event.target)) {
      this.clearPreview();
      return;
    }
    const slot = this.layout.pickSlotAtScreen(event.clientX, event.clientY);
    if (slot === null) { this.clearPreview(); return; }
    event.preventDefault(); // Allow HTML5 drop on the WebGL canvas.
    const allowed = this.layout.canDropMachine(this.draggingMachine, slot);
    if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? 'move' : 'none';
    this.layout.previewDrop(slot, allowed);
    const hint = this.root.querySelector<HTMLElement>('[data-3d-drop-hint]');
    if (hint) hint.textContent = allowed
      ? `3D target: Slot ${slot + 1} — release to place / swap`
      : `Slot ${slot + 1} occupied. Store a machine first.`;
  };

  private readonly onSceneDrop = (event: DragEvent): void => {
    if (!this.enabled || this.draggingMachine === null || !(event.target instanceof Node)) return;
    const scene = document.getElementById('scene-container');
    if (!scene?.contains(event.target)) return;
    event.preventDefault();
    const machine = this.draggingMachine;
    const slot = this.layout.pickSlotAtScreen(event.clientX, event.clientY);
    this.clearPreview();
    this.draggingMachine = null;
    if (slot === null || !this.layout.canDropMachine(machine, slot)) return;
    this.selectedMachine = machine;
    this.handlers.onPlace(machine, slot);
    this.render();
  };

  private readonly onGlobalDragEnd = (): void => {
    this.draggingMachine = null;
    this.clearPreview();
  };

  private clearPreview(): void {
    this.layout.previewDrop(null, false);
    const hint = this.root.querySelector<HTMLElement>('[data-3d-drop-hint]');
    if (hint) hint.textContent = 'Drag a machine over the 3D factory slot, then release.';
  }

  constructor(private layout: SmartFactoryLayout, private handlers: LibraryHandlers) {
    document.getElementById('flowspace-machine-library')?.remove();
    const root = document.createElement('div');
    root.id = 'flowspace-machine-library';
    root.style.cssText = [
      'position:fixed', 'bottom:15px', 'left:50%', 'transform:translateX(-50%)',
      'width:430px', 'max-width:calc(100vw - 32px)', 'max-height:48vh',
      'overflow:auto', 'z-index:10006', 'background:rgba(14,26,47,.97)',
      'color:white', 'border:1px solid #ff6b00', 'border-radius:13px',
      'box-shadow:0 12px 32px #0006', 'padding:12px',
      'box-sizing:border-box', 'font:13px/1.4 Arial,sans-serif', 'display:none',
    ].join(';');
    root.addEventListener('click', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('button[data-library-action]');
      if (!button || !root.contains(button) || !this.enabled) return;
      const action = button.dataset.libraryAction;
      const index = Number(button.dataset.machine);
      const slot = Number(button.dataset.slot);
      if (action === 'choose' && Number.isInteger(index) && index >= 0 && index < 3) {
        this.selectedMachine = index;
      } else if (action === 'remove' && Number.isInteger(index) && index >= 0 && index < 3) {
        this.handlers.onRemove(index);
        this.selectedMachine = index;
      } else if (action === 'slot' && this.selectedMachine !== null && Number.isInteger(slot)) {
        this.handlers.onPlace(this.selectedMachine, slot);
      } else if (action === 'reset') {
        this.selectedMachine = null;
        this.handlers.onReset();
      }
      this.render();
    });
    root.addEventListener('dragstart', event => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const entry = target.closest<HTMLElement>('[data-library-machine]');
      if (!entry || !this.enabled || !event.dataTransfer) return;
      const index = Number(entry.dataset.libraryMachine);
      if (!Number.isInteger(index) || index < 0 || index > 2) return;
      event.dataTransfer.setData('text/plain', String(index));
      event.dataTransfer.setData('application/x-flowspace-machine', String(index));
      event.dataTransfer.effectAllowed = 'move';
      this.draggingMachine = index;
      this.selectedMachine = index;
    });
    root.addEventListener('dragover', event => {
      if (event.target instanceof Element && event.target.closest('[data-library-slot]')) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      }
    });
    root.addEventListener('drop', event => {
      if (!this.enabled || !(event.target instanceof Element)) return;
      const slotEl = event.target.closest<HTMLElement>('[data-library-slot]');
      if (!slotEl || !event.dataTransfer) return;
      event.preventDefault();
      const index = Number(event.dataTransfer.getData('text/plain'));
      const slot = Number(slotEl.dataset.librarySlot);
      if (!Number.isInteger(index) || index < 0 || index > 2 || !Number.isInteger(slot)) return;
      this.selectedMachine = index;
      this.handlers.onPlace(index, slot);
      this.render();
    });
    document.body.appendChild(root);
    this.root = root;
    // Native browser HTML drag can now land on the actual 3D canvas, not just HTML slots.
    document.addEventListener('dragover', this.onSceneDragOver);
    document.addEventListener('drop', this.onSceneDrop);
    document.addEventListener('dragend', this.onGlobalDragEnd, true);
  }

  show(visible: boolean): void {
    this.enabled = visible;
    if (!visible) this.onGlobalDragEnd();
    this.root.style.display = visible ? 'block' : 'none';
    if (visible) this.render();
  }

  render(): void {
    if (!this.enabled) return;
    const button = 'padding:6px 9px;border-radius:6px;border:1px solid #5876a2;background:#123c8c;color:white;cursor:pointer';
    const machineRows = MACHINE_NAMES.map((name, index) => {
      const slot = this.layout.getSlot(index);
      const parked = slot === null;
      const selected = this.selectedMachine === index;
      return `<div data-library-machine="${index}" draggable="true" style="display:flex;align-items:center;gap:8px;padding:7px;margin-top:5px;border:1px solid ${selected ? '#ff6b00' : '#405673'};border-radius:8px;cursor:grab">
        <span style="display:inline-block;width:12px;height:12px;background:${PALETTE[index]};border-radius:4px"></span>
        <strong style="flex:1">${name}</strong>
        <small style="opacity:.7">${parked ? 'In library' : `Slot ${slot + 1}`}</small>
        <button type="button" data-library-action="choose" data-machine="${index}" style="${button}">${selected ? 'Selected' : 'Select'}</button>
        ${parked ? '' : `<button type="button" data-library-action="remove" data-machine="${index}" style="${button};background:#753b33">Store</button>`}
      </div>`;
    }).join('');
    const slotButtons = [0, 1, 2].map(slot => {
      const occupant = this.layout.getOccupant(slot);
      return `<button type="button" data-library-action="slot" data-library-slot="${slot}" data-slot="${slot}" style="${button};background:${occupant === null ? '#146a46' : '#223a5d'};flex:1;min-height:52px;text-align:center">
        Slot ${slot + 1}<br><small>${occupant === null ? 'EMPTY' : MACHINE_NAMES[occupant]}</small>
      </button>`;
    }).join('');
    this.root.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
      <strong style="font-size:15px">🏭 Machine Library</strong>
      <button type="button" data-library-action="reset" style="${button};background:#b2501b">Reset Layout</button></div>
      <div style="font-size:11px;color:#c8d7ec;margin:5px 0 8px">Layout Mode • Drag a machine to a 3D factory slot (highlighted), or use Select → Slot. Store keeps a machine in the library.</div>
      <div data-3d-drop-hint role="status" style="font-size:11px;color:#8df3b2;margin:0 0 8px">Drag a machine over the 3D factory slot, then release.</div>
      ${machineRows}
      <div style="display:flex;gap:7px;margin-top:10px">${slotButtons}</div>
      <div style="font-size:11px;color:#ffcc7e;margin-top:7px">Finish placing all 3 machines before switching to Simulation.</div>`;
  }

  dispose(): void {
    this.onGlobalDragEnd();
    document.removeEventListener('dragover', this.onSceneDragOver);
    document.removeEventListener('drop', this.onSceneDrop);
    document.removeEventListener('dragend', this.onGlobalDragEnd, true);
    this.root.remove();
  }
}
