import {
  BoxGeometry,
  CylinderGeometry,
  DistanceGrabbable,
  Grabbed,
  GrabSystem,
  MovementMode,
  Mesh,
  MeshBasicMaterial,
  Pressed,
  RayInteractable,
  createSystem,
} from '@iwsdk/core';
import { Raycaster, Vector2, Vector3 } from 'three';
import { createFactoryPlacementGuard } from './factory-placement-guard.js';
import { createXRMachineInfo } from './xr-machine-info.js';
import { SmartFactoryLayout } from './smart-factory-layout.js';
import { MachineLibraryPanel } from './machine-library.js';
import { FactoryLayoutPresetsPanel } from './layout-presets.js';
import { FactoryPlacementController } from './factory-placement.js';
import { SpatialFactoryMenu } from './spatial-factory-menu.js';
import { ProductionSyncPanel } from './production-sync.js';
import { SpatialProductionDashboard } from './spatial-production-dashboard.js';
import type { FactoryLayoutSnapshot } from './smart-factory-layout.js';
import type { World } from '@iwsdk/core';

// FlowSpace MR V2: a small, explicitly simplified discrete-flow simulation.
// Unit: one batch. Times are simulated seconds, not measured factory data.
const BLUE = 0x123c8c;
const ORANGE = 0xff6b00;
const NAVY = 0x14243a;
const YELLOW = 0xffd166;
const GREEN = 0x22c55e;
const GREY = 0x657080;
const RED = 0xef4444;
const BUFFER_CAPACITY = 5;
const MAX_RAW_STOCK = 999;
const BASE_CYCLE_TIMES = [2.6, 4.3, 3.1] as const;
const STATION_NAMES = ['Mixing', 'Processing', 'Packaging'] as const;
const STATION_X = [-1.55, 0, 1.55] as const;
const STATION_COLORS = [BLUE, ORANGE, BLUE] as const;

interface Station {
  enabled: boolean;
  busy: boolean;
  blocked: boolean;
  progress: number;
  cycleTime: number;
  completedCycles: number;
  body: Mesh;
  rotor: Mesh;
  progressBar: Mesh;
  workpiece: Mesh;
}

export class FactorySystem extends createSystem({
  machinePressed: { required: [RayInteractable, Pressed] },
  machineGrabbed: { required: [DistanceGrabbable, Grabbed] },
}) {
  private placementGuard: ReturnType<typeof createFactoryPlacementGuard> | null = null;
  private uiPointerHeld = false;

  private onUiPointerDown = (event: PointerEvent): void => {
    if (
      event.target instanceof Element &&
      event.target.closest('button')
    ) {
      this.uiPointerHeld = true;
    }
  };

  private onUiPointerUp = (): void => {
    this.uiPointerHeld = false;
  };

  private running = false;
  private speed = 1;
  private simulatedSeconds = 0;
  private completedProducts = 0;
  private rawStock = 60;
  private buffers = [0, 0];
  private completionTimes: number[] = [];
  private stations: Station[] = [];
  private panel: HTMLDivElement | null = null;
  private dashboardClock = 0;
  private bufferProductMeshes: Mesh[][] = [[], []];
  private finishedProductMeshes: Mesh[] = [];
  private machineEntityIndices = new Map<number, number>();
  private selectedStation: number | null = null;
  private inspectorPanel: HTMLDivElement | null = null;
  private disposeDesktopSelection: (() => void) | null = null;
  private xrInfo: ReturnType<typeof createXRMachineInfo> | null = null;
  private machineBodies: Mesh[] = [];
  private machineHomes: Vector3[] = [];
  private machineEntities: Array<ReturnType<World['createTransformEntity']>> = [];
  private smartLayout: SmartFactoryLayout | null = null;
  private machineLibrary: MachineLibraryPanel | null = null;
  private layoutPresets: FactoryLayoutPresetsPanel | null = null;
  private factoryPlacement: FactoryPlacementController | null = null;
  private spatialMenu: SpatialFactoryMenu | null = null;
  private productionSync: ProductionSyncPanel | null = null;
  private spatialProduction: SpatialProductionDashboard | null = null;
  // Block new machine selections/grabs while a spatial menu button owns input.
  private menuInputBlockUntil = 0;
  private readonly menuRejectedGrabs = new Set<number>();

  private spatialMenuHasPriority(): boolean {
    return performance.now() < this.menuInputBlockUntil ||
      this.spatialMenu?.isHoveringButton() === true ||
      this.spatialProduction?.isHoveringButton() === true;
  }
  private parkedEnabled = [true, true, true];
  private layoutMode = false;
  private grabEnabled = true;
  private layoutToolbar: HTMLDivElement | null = null;
  private buildingMachine: number | null = null;
  private conveyorSlats: Mesh[] = [];
  private mixerIndicator: Mesh | null = null;
  private packagingPiston: Mesh | null = null;
  private signalLamps: Mesh[] = [];

  private setBuildingMachine(index: number | null): void {
    this.buildingMachine = index;
  }

  // Attach decorative pieces to a machine's grab root as local children.
  // The children do not need their own ECS entities.
  private placeSceneMesh(mesh: Mesh, clickableStation?: number): void {
    if (clickableStation !== undefined) {
      const entity = this.factoryPlacement
        ? this.factoryPlacement.createFactoryEntity(mesh)
        : this.world.createTransformEntity(mesh);
      entity.addComponent(RayInteractable);
      entity.addComponent(DistanceGrabbable, {
        translate: true,
        rotate: true,
        scale: false,
        movementMode: MovementMode.MoveFromTarget,
        returnToOrigin: false,
      });
      this.machineEntityIndices.set(entity.index, clickableStation);
      this.machineEntities[clickableStation] = entity;
      this.machineBodies[clickableStation] = mesh;
      this.machineHomes[clickableStation] = mesh.position.clone();
      this.setBuildingMachine(clickableStation);
    } else if (this.buildingMachine !== null) {
      const index = this.buildingMachine;
      const root = this.machineBodies[index];
      const home = this.machineHomes[index];
      if (!root || !home) throw new Error('Machine root must exist before adding parts');
      mesh.position.sub(home);
      root.add(mesh);
    } else {
      if (this.factoryPlacement) {
        this.factoryPlacement.createFactoryEntity(mesh);
      } else {
        this.world.createTransformEntity(mesh);
      }
    }
  }

  private block(
    size: [number, number, number],
    position: [number, number, number],
    color: number,
    clickableStation?: number,
  ): Mesh {
    const mesh = new Mesh(
      new BoxGeometry(...size),
      new MeshBasicMaterial({ color }),
    );
    mesh.position.set(...position);
    this.placeSceneMesh(mesh, clickableStation);
    return mesh;
  }

  init(): void {
    document.addEventListener('pointerdown', this.onUiPointerDown, true);
    window.addEventListener('pointerup', this.onUiPointerUp, true);
    window.addEventListener('pointercancel', this.onUiPointerUp, true);
    this.factoryPlacement = new FactoryPlacementController(this.world, () => {
      this.running = false;
      this.refreshDashboard();
    });
    this.makeFactoryScene();
    this.placementGuard = createFactoryPlacementGuard(this.machineBodies);
    this.xrInfo = createXRMachineInfo(this.world);
    this.smartLayout = new SmartFactoryLayout(this.world, this.machineBodies);
    this.machineLibrary = new MachineLibraryPanel(this.smartLayout, {
      onRemove: index => this.storeMachine(index),
      onPlace: (index, slot) => this.placeLibraryMachine(index, slot),
      onReset: () => this.resetLibraryLayout(),
    });
    this.layoutPresets = new FactoryLayoutPresetsPanel({
      capture: () => this.smartLayout?.snapshot() ?? null,
      apply: (layout) => this.loadSavedFactoryLayout(layout),
      reset: () => this.resetLibraryLayout(),
    });
    // V4-D.4.2: a hovered XR menu button takes priority over NEW machine/factory grabs.
    // Do not interrupt an existing grab held by another hand.
    this.queries.machineGrabbed.subscribe('qualify', (entity) => {
      const isFactoryHandle = entity.index === this.factoryPlacement?.grabEntityIndex;
      const isMachine = this.machineEntityIndices.has(entity.index);
      if ((isFactoryHandle || isMachine) && this.spatialMenuHasPriority()) {
        this.menuRejectedGrabs.add(entity.index);
        this.world.getSystem(GrabSystem)?.forceRelease(entity);
        return;
      }
      if (isFactoryHandle) this.factoryPlacement?.beginGrab();
    });
    this.queries.machineGrabbed.subscribe('disqualify', (entity) => {
      // A canceled menu-overlap grab never needs a slot drop or endGrab callback.
      if (this.menuRejectedGrabs.delete(entity.index)) return;
      if (entity.index === this.factoryPlacement?.grabEntityIndex) {
        this.factoryPlacement?.endGrab();
        return;
      }
      if (!this.layoutMode) return;
      const index = this.machineEntityIndices.get(entity.index);
      if (index === undefined) return;
      const result = this.smartLayout?.drop(index);
      this.setLayoutMessage(result === 'swapped' ? 'Machines swapped!' :
        result === 'snapped' ? 'Placed in slot.' : 'Invalid position; returned to slot.');
      this.refreshMachineInspector();
      this.machineLibrary?.render();
    });
    this.makeLayoutToolbar();
    this.setLayoutMode(false); // Start in Simulation mode; layout is unlocked explicitly.
    this.queries.machinePressed.subscribe('qualify', (entity) => {
      if (this.spatialMenu?.handlePressed(entity.index)) {
        this.menuInputBlockUntil = performance.now() + 250;
        return;
      }
      if (this.spatialProduction?.handlePressed(entity.index)) {
        this.menuInputBlockUntil = performance.now() + 350;
        return;
      }
      // Ignore coincident machine presses while a spatial menu control is targeted.
      if (this.spatialMenuHasPriority()) return;
      const stationIndex = this.machineEntityIndices.get(entity.index);
      // Select a station rather than toggling its power immediately.
      if (stationIndex !== undefined) this.selectStation(stationIndex);
    });
    this.makeDashboard();
    // V5.2: The DB remains authoritative; this only runs a local 3D demo.
    this.productionSync = new ProductionSyncPanel({
      startSimulation: (order) => {
        if (this.layoutMode) throw new Error('Switch to Simulation Mode first.');
        if (this.factoryPlacement?.isFactoryGrabEnabled) {
          throw new Error('Disable Factory Grab before starting a linked order.');
        }
        if (this.smartLayout?.hasParked()) {
          throw new Error('Place all machines before starting a linked order.');
        }
        if (this.running) throw new Error('Pause the current free simulation first.');
        this.resetProduction();
        // One simulated raw input batch per finished unit. This is NOT a kg stock count.
        this.rawStock = order.quantity;
        this.running = true;
        this.refreshDashboard();
      },
      stopSimulation: () => {
        this.running = false;
        this.refreshDashboard();
      },
      abandonSimulation: () => {
        this.resetProduction();
        this.refreshDashboard();
      },
    });
    if (this.panel) this.productionSync.mount(this.panel);
    this.makeMachineInspector();
    // World-space controls. The Start button delegates to the EXISTING HTML
    // handler, so all production/layout safety checks stay identical.
    this.spatialMenu = new SpatialFactoryMenu(this.world, {
      toggleProduction: () => {
        this.panel?.querySelector<HTMLButtonElement>('button[data-flow="toggle"]')?.click();
      },
      toggleLayout: () => this.setLayoutMode(!this.layoutMode),
      selectStation: (index) => this.selectStation(index),
      // XR actions use the SAME validated storage and library logic as the HTML UI.
      saveLayout: () => this.layoutPresets?.saveForXR()
        ?? { ok: false, message: 'Saved layouts unavailable' },
      nextLayout: () => this.layoutPresets?.nextForXR()
        ?? { ok: false, message: 'Saved layouts unavailable' },
      loadLayout: () => this.layoutPresets?.loadForXR()
        ?? { ok: false, message: 'Saved layouts unavailable' },
      storeSelected: () => {
        const index = this.selectedStation;
        if (!this.layoutMode || index === null) return { ok: false, message: 'Select a machine first' };
        if (this.smartLayout?.isParked(index)) return { ok: false, message: 'Machine is already stored' };
        this.storeMachine(index);
        // Keep the parked station selected so the user can place it directly.
        if (this.smartLayout?.isParked(index)) this.selectStation(index);
        return this.smartLayout?.isParked(index)
          ? { ok: true, message: `${STATION_NAMES[index]} stored in library` }
          : { ok: false, message: 'Cannot store selected machine' };
      },
      placeSelected: (slot) => {
        const index = this.selectedStation;
        if (!this.layoutMode || index === null) return { ok: false, message: 'Select a machine first' };
        this.placeLibraryMachine(index, slot);
        const ok = this.smartLayout?.getSlot(index) === slot;
        return ok
          ? { ok: true, message: `${STATION_NAMES[index]} placed in Slot ${slot + 1}` }
          : { ok: false, message: 'Invalid slot or overlap; layout unchanged' };
      },
      resetLayout: () => {
        if (!this.layoutMode) return { ok: false, message: 'Switch to Layout Mode first' };
        this.resetLibraryLayout();
        return { ok: true, message: 'Original factory layout restored' };
      },
    });
    // V5.3: Spatial panel delegates to the SAME V5.2 validated workflow.
    const v52 = this.productionSync;
    if (v52) {
      this.spatialProduction = new SpatialProductionDashboard(this.world, {
        snapshot: () => v52.getSpatialSnapshot(),
        refresh: () => { void v52.refreshForXR(); },
        selectNext: () => v52.selectNextDraftForXR(),
        start: () => { void v52.startForXR(); },
        confirm: () => { void v52.confirmForXR(); },
      });
    }
    this.setupDesktopSelection();
    this.refreshDashboard();
  }

  private makeFactoryScene(): void {
    // Platform and conveyor are moved nearer than V1 for better desktop visibility.
    this.block([5.15, 0.12, 1.75], [0, 0.53, -2.60], NAVY);
    this.block([4.65, 0.13, 0.57], [0, 0.79, -2.43], GREY);
    this.block([4.48, 0.04, 0.43], [0, 0.88, -2.43], 0x202b3e);
    this.block([4.62, 0.10, 0.055], [0, 0.93, -2.73], 0xb8c2ce);
    this.block([4.62, 0.10, 0.055], [0, 0.93, -2.13], 0xb8c2ce);

    // Machines and animated rotors. Their large bodies are ray-interactable.
    for (let i = 0; i < 3; i++) {
      const x = STATION_X[i];
      const height = i === 1 ? 1.02 : 0.83;
      const bodyY = 0.94 + height / 2;
      const body = this.block(
        [0.76, height, 0.64],
        [x, bodyY, -2.89],
        STATION_COLORS[i],
        i,
      );
      this.block([0.66, 0.065, 0.68], [x, 0.93, -2.89], 0x101827);
      this.block([0.58, 0.12, 0.11], [x, bodyY + 0.09, -2.54], 0xc5d5e4);
      const rotor = this.block([0.63, 0.06, 0.16], [x, bodyY + height / 2 + 0.08, -2.89], YELLOW);
      const progressBar = this.block([0.61, 0.06, 0.075], [x, 1.99, -2.48], GREEN);
      progressBar.scale.x = 0.01;
      const workpiece = this.block([0.19, 0.19, 0.19], [x, 1.02, -2.06], YELLOW);
      workpiece.visible = false;
      this.stations.push({
        enabled: true,
        busy: false,
        blocked: false,
        progress: 0,
        cycleTime: BASE_CYCLE_TIMES[i],
        completedCycles: 0,
        body,
        rotor,
        progressBar,
        workpiece,
      });
    }

    this.setBuildingMachine(null);

    // FlowSpace MR V3-B: Industrial details

    const addCylinder = (
      radius: number,
      height: number,
      position: [number, number, number],
      color: number,
      horizontal = false
    ) => {
      const mesh = new Mesh(
        new CylinderGeometry(radius, radius, height, 24),
        new MeshBasicMaterial({ color })
      );

      mesh.position.set(...position);

      if (horizontal) {
        mesh.rotation.x = Math.PI / 2;
      }

      this.placeSceneMesh(mesh);
      return mesh;
    };

    this.setBuildingMachine(0);
    // MIXING: stainless-steel tank and motor
    addCylinder(
      0.31, 0.38,
      [-1.55, 1.98, -2.89],
      0xb8c8d6
    );

    addCylinder(
      0.34, 0.05,
      [-1.55, 2.20, -2.89],
      0xe1e8ef
    );

    addCylinder(
      0.14, 0.19,
      [-1.55, 2.32, -2.89],
      0xff6b00
    );

    this.block(
      [0.08, 0.48, 0.08],
      [-1.12, 1.94, -2.89],
      0x9eafbe
    );

    this.setBuildingMachine(1);
    // PROCESSING: metallic chamber and vents
    this.block(
      [0.59, 0.43, 0.05],
      [0, 1.43, -2.53],
      0xc6d2df
    );

    this.block(
      [0.47, 0.27, 0.06],
      [0, 1.40, -2.49],
      0x25374d
    );

    for (const y of [1.65, 1.72, 1.79]) {
      this.block(
        [0.43, 0.025, 0.06],
        [0, y, -2.50],
        0x9cabb8
      );
    }

    this.setBuildingMachine(2);
    // PACKAGING: frame and sealing equipment
    for (const x of [1.27, 1.83]) {
      this.block(
        [0.06, 0.62, 0.08],
        [x, 1.40, -2.49],
        0xd1dce6
      );
    }

    this.block(
      [0.64, 0.10, 0.12],
      [1.55, 1.72, -2.48],
      0xff6b00
    );

    this.block(
      [0.54, 0.06, 0.13],
      [1.55, 1.25, -2.47],
      0xc1ced9
    );

    this.setBuildingMachine(null);
    // CONVEYOR: industrial rollers
    for (let i = 0; i < 13; i++) {
      const x = -2.16 + i * 0.36;

      addCylinder(
        0.034, 0.47,
        [x, 0.93, -2.43],
        0x9cabbb,
        true
      );
    }

    // Conveyor support legs
    for (const x of [-1.9, -0.6, 0.6, 1.9]) {
      this.block(
        [0.09, 0.25, 0.10],
        [x, 0.69, -2.43],
        0x8898a9
      );
    }

    // V3-D: Machine details that move together with their parent body.
    this.setBuildingMachine(0);
    this.mixerIndicator = this.block(
      [0.48, 0.035, 0.08], [-1.55, 2.47, -2.89], ORANGE,
    );
    this.setBuildingMachine(2);
    this.packagingPiston = this.block(
      [0.50, 0.07, 0.12], [1.55, 1.57, -2.38], YELLOW,
    );
    this.setBuildingMachine(null);
    for (let i = 0; i < 11; i++) {
      this.conveyorSlats.push(this.block(
        [0.045, 0.015, 0.35], [-2.1 + i * 0.4, 0.91, -2.43],
        0xffb66b,
      ));
    }
    for (let i = 0; i < 3; i++) {
      this.setBuildingMachine(i);
      this.signalLamps.push(this.block(
        [0.13, 0.09, 0.11], [STATION_X[i], 2.17, -2.49], GREEN,
      ));
    }
    this.setBuildingMachine(null);

    // Products queued between the three stations.
    for (let b = 0; b < 2; b++) {
      for (let slot = 0; slot < BUFFER_CAPACITY; slot++) {
        const x = b === 0 ? -1.11 + slot * 0.17 : 0.45 + slot * 0.17;
        const mesh = this.block([0.13, 0.15, 0.15], [x, 1.02, -2.15], b === 0 ? YELLOW : 0x78dcca);
        mesh.visible = false;
        this.bufferProductMeshes[b].push(mesh);
      }
    }
    // A visual preview of up to six finished items on the output side.
    for (let i = 0; i < 6; i++) {
      const mesh = this.block(
        [0.13, 0.15, 0.15],
        [2.10 + (i % 2) * 0.15, 1.01 + Math.floor(i / 2) * 0.15, -2.35],
        GREEN,
      );
      mesh.visible = false;
      this.finishedProductMeshes.push(mesh);
    }
    this.refreshScene(0);
  }

  // XR can select through RayInteractable + Pressed. On desktop, also raycast
  // explicitly, so clicking works even when canvas pointer events are disabled.
  // A drag is NOT treated as a click, preserving orbit-camera behavior.
  private setupDesktopSelection(): void {
    const canvas = document.querySelector<HTMLCanvasElement>('#scene-container canvas');
    if (!canvas) {
      console.warn('FlowSpace: canvas not found; XR selection remains available');
      return;
    }

    const raycaster = new Raycaster();
    const pointer = new Vector2();
    let downPosition: { x: number; y: number } | null = null;

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      downPosition = { x: event.clientX, y: event.clientY };
    };

    const onPointerUp = (event: PointerEvent): void => {
      const start = downPosition;
      downPosition = null;
      if (!start || event.button !== 0) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      if (this.world.visibilityState.value !== 'non-immersive') return;

      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, this.world.camera);
      const hits = raycaster.intersectObjects(this.stations.map((s) => s.body), false);
      if (!hits.length) return;
      const stationIndex = this.stations.findIndex((s) => s.body === hits[0].object);
      if (stationIndex !== -1) this.selectStation(stationIndex);
    };

    const onPointerCancel = (): void => { downPosition = null; };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    this.disposeDesktopSelection = () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
    };

    // V4-B free desktop rotation: Shift + drag on a machine.
    // Alt + Shift + drag rolls around the machine's local Z axis.
    // Capture phase prevents the orbit camera from handling this drag.
    let rotationIndex: number | null = null;
    let rotationPointerId: number | null = null;
    let previousX = 0;
    let previousY = 0;

    const onRotateDown = (event: PointerEvent): void => {
      if (event.button !== 0 || !event.shiftKey || !this.layoutMode) return;
      if (this.world.visibilityState.value !== 'non-immersive') return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, this.world.camera);
      const hits = raycaster.intersectObjects(this.stations.map(s => s.body), false);
      if (!hits.length) return;
      const index = this.stations.findIndex(s => s.body === hits[0].object);
      if (index < 0) return;

      rotationIndex = index;
      rotationPointerId = event.pointerId;
      previousX = event.clientX;
      previousY = event.clientY;
      downPosition = null;
      this.selectStation(index);
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onRotateMove = (event: PointerEvent): void => {
      if (rotationIndex === null || event.pointerId !== rotationPointerId) return;
      const dx = event.clientX - previousX;
      const dy = event.clientY - previousY;
      previousX = event.clientX;
      previousY = event.clientY;
      const sensitivity = 0.6; // degrees per pixel
      if (event.altKey) {
        this.rotateMachine(rotationIndex, 'z', dx * sensitivity);
      } else {
        this.rotateMachine(rotationIndex, 'y', dx * sensitivity);
        this.rotateMachine(rotationIndex, 'x', -dy * sensitivity);
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const endRotation = (event: PointerEvent): void => {
      if (rotationIndex === null || event.pointerId !== rotationPointerId) return;
      rotationIndex = null;
      rotationPointerId = null;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    canvas.addEventListener('pointerdown', onRotateDown, true);
    canvas.addEventListener('pointermove', onRotateMove, true);
    canvas.addEventListener('pointerup', endRotation, true);
    canvas.addEventListener('pointercancel', endRotation, true);
    const disposeSelection = this.disposeDesktopSelection;
    this.disposeDesktopSelection = () => {
      disposeSelection?.();
      canvas.removeEventListener('pointerdown', onRotateDown, true);
      canvas.removeEventListener('pointermove', onRotateMove, true);
      canvas.removeEventListener('pointerup', endRotation, true);
      canvas.removeEventListener('pointercancel', endRotation, true);
    };
  }

  private selectStation(index: number): void {
    if (!this.stations[index]) return;
    this.selectedStation = index;
    this.refreshMachineInspector();
  }

  private makeMachineInspector(): void {
    document.getElementById('flowspace-machine-inspector')?.remove();
    const panel = document.createElement('div');
    panel.id = 'flowspace-machine-inspector';
    panel.style.cssText = [
      'position:fixed', 'top:75px', 'right:16px', 'z-index:9998',
      'width:285px', 'max-width:calc(100vw - 32px)',
      'box-sizing:border-box', 'padding:16px', 'border-radius:13px',
      'border:1px solid #466997', 'background:rgba(14,26,47,.97)',
      'box-shadow:0 12px 30px #0005', 'color:white',
      'font:13px/1.6 Arial,sans-serif', 'display:none'
    ].join(';');

    panel.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLButtonElement>('button[data-machine-action]');
      if (!button || !panel.contains(button)) return;
      const action = button.dataset.machineAction;
      const index = this.selectedStation;
      if (action === 'close') {
        this.selectedStation = null;
      } else if (index !== null && this.stations[index]) {
        if (action === 'toggle') this.toggleStation(index);
        if (action === 'place-swap' && this.layoutMode) {
          const result = this.smartLayout?.drop(index);
          this.setLayoutMessage(result === 'swapped' ? 'Machines swapped!' :
            result === 'snapped' ? 'Placed in slot.' : 'Invalid position; returned to slot.');
        }
        if (action === 'closer') this.moveMachineAlongView(index, -0.35);
        if (action === 'farther') this.moveMachineAlongView(index, 0.35);
        if (action === 'reset-pose') this.resetMachinePose(index);
        if (action?.endsWith('-plus') || action?.endsWith('-minus')) {
          const axis = action.charAt(0) as 'x' | 'y' | 'z';
          const degrees = action.endsWith('-plus') ? 15 : -15;
          this.rotateMachine(index, axis, degrees);
        }
        if (action === 'upgrade') {
          this.stations[index].cycleTime = Math.max(1, this.stations[index].cycleTime * 0.9);
          this.refreshDashboard();
        }
      }
      this.refreshMachineInspector();
    });

    document.body.appendChild(panel);
    this.inspectorPanel = panel;
  }

  private refreshMachineInspector(): void {
    const panel = this.inspectorPanel;
    const index = this.selectedStation;
    if (!panel) return;
    if (index === null || !this.stations[index]) {
      panel.style.display = 'none';
      this.xrInfo?.hide();
      return;
    }

    const station = this.stations[index];
    const status = !station.enabled ? 'OFF' : station.blocked ? 'BLOCKED' : station.busy ? 'PROCESSING' : 'WAITING';
    const progress = station.busy ? Math.min(100, Math.round(station.progress / station.cycleTime * 100)) : 0;
    const inbound = index === 0 ? this.rawStock : this.buffers[index - 1];
    const output = index === 2 ? this.completedProducts : this.buffers[index];
    const unitRate = 60 * this.speed / station.cycleTime;
    const buttonStyle = 'padding:8px 10px;background:#123c8c;color:white;border:1px solid #5c82b2;border-radius:7px;cursor:pointer';

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <strong style="font-size:17px">${index + 1}. ${STATION_NAMES[index]}</strong>
        <button data-machine-action="close" aria-label="Close details" style="${buttonStyle}">✕</button>
      </div>
      <div style="color:${station.enabled ? '#77e6ac' : '#ff9c9c'};font-weight:700;margin:7px 0">${status}</div>
      <div>Cycle time: <b>${station.cycleTime.toFixed(2)} seconds</b></div>
      <div>Finished batches: <b>${station.completedCycles}</b></div>
      <div>Current cycle: <b>${progress}%</b></div>
      <div style="height:6px;background:#334760;border-radius:7px;overflow:hidden;margin:7px 0">
        <div style="width:${progress}%;height:100%;background:#ff6b00"></div>
      </div>
      <div>Input available: <b>${inbound} batches</b></div>
      <div>${index === 2 ? 'Total products' : 'Output buffer'}: <b>${output}</b></div>
      <div style="font-size:12px;opacity:.75;margin:6px 0 12px">Nominal capacity: ${unitRate.toFixed(1)} batches/min (at current speed)</div>
      <div style="display:flex;flex-wrap:wrap;gap:7px">
        <button data-machine-action="toggle" style="${buttonStyle}">${station.enabled ? 'Turn OFF' : 'Turn ON'}</button>
        <button data-machine-action="upgrade" style="${buttonStyle}">Improve cycle −10%</button>
      </div>
      <div style="font-weight:bold;margin:12px 0 6px">Machine position &amp; rotation</div>
      ${this.layoutMode ? `<button data-machine-action="place-swap" style="${buttonStyle};background:#ff6b00;margin:0 0 8px">Place / Swap selected machine</button>` : `<div style="font-size:11px;color:#ffcb6b;margin-bottom:8px">Switch to Layout Mode to move machines.</div>`}
      <div style="font-size:11px;color:#bcd1ea;margin-bottom:8px">Desktop: Shift + drag machine = free X/Y rotation; Shift + Alt + drag = Z rotation.</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button data-machine-action="closer" style="${buttonStyle}">Closer</button>
        <button data-machine-action="farther" style="${buttonStyle}">Farther</button>
        <button data-machine-action="reset-pose" style="${buttonStyle}">Reset pose</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        ${(['x', 'y', 'z'] as const).map(axis => `
          <button data-machine-action="${axis}-minus" style="${buttonStyle}">${axis.toUpperCase()} −15°</button>
          <button data-machine-action="${axis}-plus" style="${buttonStyle}">${axis.toUpperCase()} +15°</button>
        `).join('')}
      </div>
    `;
    panel.style.display = 'block';
    this.xrInfo?.show(index, {
      name: STATION_NAMES[index],
      status,
      cycle: station.cycleTime,
      batches: station.completedCycles,
      progress,
    }, this.machineBodies[index].getWorldPosition(new Vector3()));
  }

  private toggleStation(index: number): void {
    if (this.smartLayout?.isParked(index)) return;
    const station = this.stations[index];
    if (!station) return;
    station.enabled = !station.enabled;
    (station.body.material as MeshBasicMaterial).color.setHex(
      station.enabled ? STATION_COLORS[index] : 0x485160,
    );
    this.refreshScene(0);
    this.refreshDashboard();
    this.refreshMachineInspector();
  }

  // At the end of each cycle, the batch moves to the next buffer (if not full).
  // An offline downstream station lets the upstream buffer fill, creating a real blockage.
  private simulate(delta: number): void {
    const dt = Math.min(Math.max(delta, 0), 0.1) * this.speed;
    this.simulatedSeconds += dt;

    // Finish jobs from downstream to upstream, freeing capacity in the right order.
    for (let i = 2; i >= 0; i--) {
      const station = this.stations[i];
      station.blocked = false;
      if (!station.enabled || !station.busy) continue;
      station.progress = Math.min(station.cycleTime, station.progress + dt);
      if (station.progress < station.cycleTime) continue;

      if (i < 2 && this.buffers[i] >= BUFFER_CAPACITY) {
        station.blocked = true;
        continue;
      }
      station.completedCycles++;
      if (i === 2) {
        this.completedProducts++;
        this.completionTimes.push(this.simulatedSeconds);
      } else {
        this.buffers[i]++;
      }
      station.busy = false;
      station.progress = 0;
    }

    // Start new jobs using available material; each station handles one batch.
    for (let i = 2; i >= 0; i--) {
      const station = this.stations[i];
      if (!station.enabled || station.busy) continue;
      if (i === 0) {
        if (this.rawStock <= 0) continue;
        this.rawStock--;
      } else {
        if (this.buffers[i - 1] <= 0) continue;
        this.buffers[i - 1]--;
      }
      station.busy = true;
      station.progress = 0;
      station.blocked = false;
    }

    while (this.completionTimes.length > 0 &&
      this.completionTimes[0] < this.simulatedSeconds - 60) {
      this.completionTimes.shift();
    }
  }

  private refreshScene(delta: number): void {
    for (let i = 0; i < 3; i++) {
      const station = this.stations[i];
      const ratio = station.busy ? Math.min(1, station.progress / station.cycleTime) : 0;
      station.progressBar.scale.x = Math.max(0.01, ratio);
      station.progressBar.position.x = -(1 - Math.max(0.01, ratio)) * 0.30;
      (station.progressBar.material as MeshBasicMaterial).color.setHex(
        !station.enabled ? GREY : station.blocked ? RED : GREEN,
      );
      station.workpiece.visible = station.busy;
      if (station.busy) {
        station.workpiece.position.y = (1.02 - this.machineHomes[i].y) + Math.sin(this.simulatedSeconds * 5 + i) * 0.045;
        (station.workpiece.material as MeshBasicMaterial).color.setHex(i === 2 ? GREEN : i === 1 ? 0x78dcca : YELLOW);
      }
      if (this.running && station.enabled && station.busy && !station.blocked) {
        station.rotor.rotation.y += delta * this.speed * (1.8 + i * 0.2);
      }
    }

    for (let i = 0; i < 2; i++) {
      this.bufferProductMeshes[i].forEach((mesh, n) => {
        mesh.visible = n < this.buffers[i];
      });
    }
    this.finishedProductMeshes.forEach((mesh, n) => {
      mesh.visible = n < Math.min(this.completedProducts, this.finishedProductMeshes.length);
    });
  }

  private makeDashboard(): void {
    this.panel?.remove();
    const panel = document.createElement('div');
    panel.id = 'flowspace-v2-dashboard';
    panel.style.cssText = [
      'position:fixed', 'z-index:9999', 'top:14px', 'left:14px',
      'width:320px', 'max-width:calc(100vw - 30px)', 'max-height:calc(100vh - 30px)',
      'overflow-y:auto', 'box-sizing:border-box', 'padding:16px',
      'border-radius:13px', 'border:1px solid #29486f',
      'background:rgba(14,26,47,.96)', 'color:#fff',
      'font:13px/1.5 Arial,sans-serif', 'box-shadow:0 14px 40px #0004',
    ].join(';');
    panel.innerHTML = `
      <div style="font-size:19px;font-weight:700">FlowSpace <span style="color:#ff9b4b">MR V5.2</span></div>
      <div style="opacity:.75;margin-bottom:10px">Interactive Factory • Digital Twin Prototype</div>
      <div id="flow-state" style="font-weight:700"></div>
      <div id="flow-topstats" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0"></div>
      <div style="display:flex;gap:5px;flex-wrap:wrap">
        <button data-flow="toggle">▶ Start / Pause</button>
        <button data-flow="slower">− Speed</button>
        <button data-flow="faster">+ Speed</button>
        <button data-flow="restock">+25 Raw</button>
        <button data-flow="reset">Reset</button>
      </div>
      <div style="font-weight:700;margin-top:15px">Production stages</div>
      <div id="flow-stations"></div>
      <div style="font-weight:700;margin-top:12px">Material flow</div>
      <div id="flow-buffers"></div>
      <div id="flow-capacity" style="margin-top:9px;color:#c0d3ef"></div>
      <p style="opacity:.65;font-size:11px;margin:12px 0 0">Click a machine or its button to toggle it. This is a simplified batch simulator, not a validated industrial model.</p>
    `;
    panel.querySelectorAll('button').forEach((button) => {
      (button as HTMLButtonElement).style.cssText = [
        'padding:7px 9px', 'background:#123c8c', 'color:white',
        'border:1px solid #5577aa', 'border-radius:7px', 'cursor:pointer',
        'font:12px Arial,sans-serif',
      ].join(';');
    });
    panel.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest<HTMLButtonElement>('button[data-flow]');
      if (!button || !panel.contains(button)) return;
      const action = button.dataset.flow;
      if (this.productionSync?.hasActiveOrder() &&
          (action === 'reset' || action === 'restock' ||
           (action === 'toggle' && this.productionSync.isAwaitingPost()))) {
        this.setLayoutMessage('Finish or abandon the linked order first.');
        return;
      }
      if (action === 'toggle') {
        if (this.layoutMode) this.setLayoutMessage('Switch to Simulation Mode before Start.');
        else if (this.factoryPlacement?.isFactoryGrabEnabled) this.setLayoutMessage('Disable Factory Grab before starting production.');
        else if (this.smartLayout?.hasParked()) this.setLayoutMessage('Place all three machines before Start.');
        else this.running = !this.running;
      }
      else if (action === 'slower') this.speed = Math.max(0.5, this.speed - 0.5);
      else if (action === 'faster') this.speed = Math.min(3.0, this.speed + 0.5);
      else if (action === 'restock') this.rawStock = Math.min(MAX_RAW_STOCK, this.rawStock + 25);
      else if (action === 'reset') this.resetProduction();
      else if (action?.startsWith('station-')) {
        const index = Number(action.slice('station-'.length));
        if (Number.isInteger(index) && index >= 0 && index < 3) this.toggleStation(index);
      } else if (action?.startsWith('upgrade-')) {
        const index = Number(action.slice('upgrade-'.length));
        if (Number.isInteger(index) && index >= 0 && index < 3) {
          this.stations[index].cycleTime = Math.max(1, this.stations[index].cycleTime * 0.9);
        }
      }
      this.refreshDashboard();
    });
    document.body.appendChild(panel);
    this.panel = panel;
  }

  private rotateMachine(index: number, axis: 'x' | 'y' | 'z', degrees: number): void {
    if (!this.layoutMode) return;
    const mesh = this.machineBodies[index];
    if (!mesh) return;
    const radians = degrees * Math.PI / 180;
    if (axis === 'x') mesh.rotateX(radians);
    if (axis === 'y') mesh.rotateY(radians);
    if (axis === 'z') mesh.rotateZ(radians);
  }

  private moveMachineAlongView(index: number, step: number): void {
    if (!this.layoutMode) return;
    const mesh = this.machineBodies[index];
    if (!mesh) return;
    const camera = this.world.camera.getWorldPosition(new Vector3());
    const current = mesh.getWorldPosition(new Vector3());
    const direction = current.clone().sub(camera);
    const distance = direction.length();
    if (distance < 0.001) return;
    const nextDistance = Math.max(0.8, Math.min(15, distance + step));
    const nextWorld = camera.add(direction.normalize().multiplyScalar(nextDistance));
    if (mesh.parent) mesh.position.copy(mesh.parent.worldToLocal(nextWorld));
    else mesh.position.copy(nextWorld);
  }

  private resetMachinePose(index: number): void {
    if (!this.layoutMode) return;
    this.smartLayout?.restore(index);
  }

  // V4-B.2: Add/store existing machines; logical stage IDs never change.
  private storeMachine(index: number): void {
    if (!this.layoutMode || !this.smartLayout || !this.stations[index]) return;
    if (!this.smartLayout.park(index)) return;
    this.parkedEnabled[index] = this.stations[index].enabled;
    this.stations[index].enabled = false;
    (this.stations[index].body.material as MeshBasicMaterial).color.setHex(0x485160);
    if (this.selectedStation === index) this.selectedStation = null;
    this.setLayoutMessage(`${STATION_NAMES[index]} stored. Select an EMPTY slot to return it.`);
    this.refreshScene(0);
    this.refreshDashboard();
    this.refreshMachineInspector();
  }

  private placeLibraryMachine(index: number, slot: number): void {
    if (!this.layoutMode || !this.smartLayout) return;
    const wasParked = this.smartLayout.isParked(index);
    const result = this.smartLayout.placeMachine(index, slot);
    if (result === 'snapped' || result === 'swapped') {
      if (wasParked) {
        this.stations[index].enabled = this.parkedEnabled[index];
        (this.stations[index].body.material as MeshBasicMaterial).color.setHex(
          this.stations[index].enabled ? STATION_COLORS[index] : 0x485160
        );
      }
      this.setLayoutMessage(result === 'swapped' ? 'Machines swapped!' : 'Machine placed.');
    } else {
      this.setLayoutMessage(result === 'occupied'
        ? 'This slot is occupied. Select a green EMPTY slot.'
        : 'Cannot place there: invalid fit or overlap.');
    }
    this.refreshScene(0);
    this.refreshDashboard();
    this.refreshMachineInspector();
  }

  private resetLibraryLayout(): void {
    if (!this.layoutMode || !this.smartLayout) return;
    const parked = [0, 1, 2].map(i => this.smartLayout!.isParked(i));
    this.smartLayout.resetLayout();
    for (let i = 0; i < 3; i++) {
      if (parked[i]) this.stations[i].enabled = this.parkedEnabled[i];
      (this.stations[i].body.material as MeshBasicMaterial).color.setHex(
        this.stations[i].enabled ? STATION_COLORS[i] : 0x485160
      );
    }
    this.setLayoutMessage('Original 3-slot layout restored.');
    this.refreshScene(0);
    this.refreshDashboard();
    this.refreshMachineInspector();
  }

  /** Restore positions and parked machine states without modifying production counters. */
  private loadSavedFactoryLayout(layout: FactoryLayoutSnapshot): boolean {
    if (!this.layoutMode || !this.smartLayout) return false;
    const previouslyParked = [0, 1, 2].map(i => this.smartLayout!.isParked(i));
    if (!this.smartLayout.applySnapshot(layout)) return false;
    for (let i = 0; i < 3; i++) {
      const nowParked = this.smartLayout.isParked(i);
      if (nowParked) {
        if (!previouslyParked[i]) this.parkedEnabled[i] = this.stations[i].enabled;
        this.stations[i].enabled = false;
        if (this.selectedStation === i) this.selectedStation = null;
      } else if (previouslyParked[i]) {
        this.stations[i].enabled = this.parkedEnabled[i];
      }
      (this.stations[i].body.material as MeshBasicMaterial).color.setHex(
        this.stations[i].enabled ? STATION_COLORS[i] : 0x485160
      );
    }
    this.setLayoutMessage('Saved layout loaded. Check positions before Simulation.');
    this.machineLibrary?.render();
    this.refreshScene(0);
    this.refreshDashboard();
    this.refreshMachineInspector();
    return true;
  }

  private makeLayoutToolbar(): void {
    this.layoutToolbar?.remove();
    const toolbar = document.createElement('div');
    toolbar.id = 'flowspace-layout-toolbar';
    toolbar.style.cssText = 'position:fixed;top:15px;left:50%;transform:translateX(-50%);z-index:10005;background:rgba(20,36,58,.98);border:1px solid #ff6b00;border-radius:10px;padding:10px;color:white;font:13px Arial,sans-serif;display:flex;gap:9px;align-items:center;flex-wrap:wrap;justify-content:center';
    const button = document.createElement('button');
    button.type = 'button';
    button.style.cssText = 'cursor:pointer;background:#ff6b00;color:white;padding:8px 12px;border:0;border-radius:7px;font-weight:bold';
    button.addEventListener('click', () => this.setLayoutMode(!this.layoutMode));
    const status = document.createElement('span');
    status.id = 'flowspace-layout-status';
    status.setAttribute('aria-live', 'polite');
    toolbar.append(button, status);
    document.body.appendChild(toolbar);
    document.getElementById('flowspace-v4d2-ui-layout')?.remove();
    const uiLayoutStyle = document.createElement('style');
    uiLayoutStyle.id = 'flowspace-v4d2-ui-layout';
    uiLayoutStyle.textContent = `\n      /* Visual-only docking. Simulation, inputs and 3D callbacks are unchanged. */
      #flowspace-layout-toolbar {
        position: fixed !important;
        top: 12px !important;
        right: 16px !important;
        left: auto !important;
        transform: none !important;
        box-sizing: border-box !important;
        width: 292px !important;
        max-width: calc(100vw - 32px) !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: flex-start !important;
        align-items: stretch !important;
        gap: 5px !important;
        padding: 7px 9px !important;
      }
      #flowspace-layout-status {
        max-width: 100% !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        display: block !important;
        font-size: 11px !important;
      }
      /* The right-side inspector and the saved-layout panel do not stack. */
      #flowspace-machine-inspector {
        top: 105px !important;
        max-height: calc(100vh - 120px) !important;
        overflow-y: auto !important;
      }
      body.flowspace-layout-mode #flowspace-machine-inspector {
        max-height: max(130px, calc(100vh - 470px)) !important;
      }
      body.flowspace-layout-mode #flowspace-layout-presets {
        bottom: 14px !important;
        max-height: min(38vh, 320px) !important;
        overflow-y: auto !important;
      }
      /* Leave a clear left-of-center lane for the world-space XR menu. */
      #flowspace-machine-library {
        left: calc(50% + 105px) !important;
        transform: translateX(-50%) !important;
        width: 400px !important;
        max-height: min(44vh, 345px) !important;
      }
      #flowspace-factory-placement {
        left: calc(50% + 105px) !important;
        transform: translateX(-50%) !important;
        width: 400px !important;
        max-height: min(39vh, 320px) !important;
      }
      @media (max-width: 1199px) {
        #flowspace-v2-dashboard { width: 260px !important; }
        #flowspace-layout-toolbar { width: 245px !important; }
        #flowspace-machine-inspector,
        #flowspace-layout-presets { width: 245px !important; }
        #flowspace-machine-library,
        #flowspace-factory-placement {
          width: min(370px, 36vw) !important;
          left: 52% !important;
        }
      }
`;
    document.head.appendChild(uiLayoutStyle);
    this.layoutToolbar = toolbar;
  }

  private setLayoutMessage(message: string): void {
    const status = this.layoutToolbar?.querySelector('#flowspace-layout-status');
    if (status) { status.textContent = message; status.title = message; }
  }

  private setLayoutMode(enabled: boolean): void {
    if (this.productionSync?.hasActiveOrder()) {
      this.setLayoutMessage('Finish or abandon linked production before Layout Mode.');
      return;
    }
    if (!enabled && this.smartLayout?.hasParked()) {
      this.setLayoutMessage('Place all three machines before switching to Simulation.');
      return;
    }
    if (enabled) this.factoryPlacement?.setLayoutEditing(true);
    this.layoutMode = enabled;
    document.body.classList.toggle('flowspace-layout-mode', enabled);
    this.machineLibrary?.show(enabled);
    this.layoutPresets?.show(enabled);
    this.running = false; // Stop the simulation while switching modes.
    this.smartLayout?.showGuides(enabled);
    if (!enabled) {
      this.smartLayout?.restoreAll();
      if (this.grabEnabled) {
        const grabSystem = this.world.getSystem(GrabSystem);
        for (const entity of this.machineEntities) {
          if (!entity) continue;
          grabSystem?.forceRelease(entity);
          entity.removeComponent(DistanceGrabbable);
        }
        this.grabEnabled = false;
      }
    } else if (!this.grabEnabled) {
      for (const entity of this.machineEntities) {
        if (!entity) continue;
        entity.addComponent(DistanceGrabbable, {
          translate: true, rotate: true, scale: false,
          movementMode: MovementMode.MoveFromTarget,
          returnToOrigin: false,
        });
      }
      this.grabEnabled = true;
    }
    if (!enabled) this.factoryPlacement?.setLayoutEditing(false);
    const button = this.layoutToolbar?.querySelector<HTMLButtonElement>('button');
    if (button) button.textContent = enabled ? 'Switch to Simulation Mode' : 'Switch to Layout Mode';
    this.setLayoutMessage(enabled ? 'Drag to a slot, then release to swap.' : 'Machines locked. Press Start to run.');
    this.refreshDashboard();
    this.refreshMachineInspector();
  }

  private animateFactoryDetails(delta: number): void {
    const mixing = this.stations[0];
    if (this.mixerIndicator && this.running && mixing.enabled && mixing.busy && !mixing.blocked) {
      this.mixerIndicator.rotation.y += delta * this.speed * 5;
    }
    const packaging = this.stations[2];
    if (this.packagingPiston) {
      const active = this.running && packaging.enabled && packaging.busy && !packaging.blocked;
      const restY = 1.57 - this.machineHomes[2].y;
      this.packagingPiston.position.y = active
        ? restY + Math.sin(this.simulatedSeconds * 9) * 0.07 : restY;
    }
    const conveyorMoving = this.running && this.stations.some(
      s => s.enabled && s.busy && !s.blocked
    );
    if (conveyorMoving) {
      for (const marker of this.conveyorSlats) {
        marker.position.x += delta * this.speed * 0.55;
        if (marker.position.x > 2.12) marker.position.x -= 4.4;
      }
    }
    this.signalLamps.forEach((lamp, index) => {
      const station = this.stations[index];
      const color = !station.enabled ? RED : station.blocked ? ORANGE
        : this.running && station.busy ? GREEN : YELLOW;
      (lamp.material as MeshBasicMaterial).color.setHex(color);
    });
  }

  private resetProduction(): void {
    this.running = false;
    this.speed = 1;
    this.simulatedSeconds = 0;
    this.completedProducts = 0;
    this.rawStock = 60;
    this.buffers = [0, 0];
    this.completionTimes = [];
    for (let i = 0; i < 3; i++) {
      const station = this.stations[i];
      station.enabled = true;
      station.busy = false;
      station.blocked = false;
      station.progress = 0;
      station.cycleTime = BASE_CYCLE_TIMES[i];
      station.completedCycles = 0;
      (station.body.material as MeshBasicMaterial).color.setHex(STATION_COLORS[i]);
    }
    this.refreshScene(0);
  }

  private refreshDashboard(): void {
    if (!this.panel) return;
    const state = this.panel.querySelector<HTMLElement>('#flow-state');
    const top = this.panel.querySelector<HTMLElement>('#flow-topstats');
    const stationsElement = this.panel.querySelector<HTMLElement>('#flow-stations');
    const buffersElement = this.panel.querySelector<HTMLElement>('#flow-buffers');
    const capacityElement = this.panel.querySelector<HTMLElement>('#flow-capacity');
    if (!state || !top || !stationsElement || !buffersElement || !capacityElement) return;

    const disabled = this.stations.filter((s) => !s.enabled).length;
    state.textContent = this.running ? (disabled ? '● RUNNING • some machines OFF' : '● RUNNING') : '● PAUSED';
    state.style.color = this.running ? (disabled ? '#ffcb6b' : '#68df9a') : '#afc2db';
    const throughput = this.completionTimes.length; // Completed in last simulated 60s.
    const inProcess = this.stations.filter((s) => s.busy).length;
    top.innerHTML = `
      <div>✅ Completed<br><strong style="font-size:20px">${this.completedProducts}</strong></div>
      <div>⚡ Speed<br><strong style="font-size:20px">${this.speed.toFixed(1)}×</strong></div>
      <div>📦 Raw stock<br><strong style="font-size:20px">${this.rawStock}</strong></div>
      <div>📈 Last 60s<br><strong style="font-size:20px">${throughput} units</strong></div>
    `;

    stationsElement.innerHTML = this.stations.map((s, index) => {
      const status = !s.enabled ? 'OFF' : s.blocked ? 'BLOCKED' : s.busy ? 'PROCESSING' : 'WAITING';
      const percent = s.busy ? Math.round((s.progress / s.cycleTime) * 100) : 0;
      const statusColor = !s.enabled ? '#ff8787' : s.blocked ? '#ffcb6b' : '#94f4c2';
      return `
        <div style="padding:8px 0;border-bottom:1px solid #32415a">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:7px">
            <span><strong>${index + 1}. ${STATION_NAMES[index]}</strong> <span style="color:${statusColor};font-size:11px">${status}</span></span>
            <button data-flow="station-${index}" style="padding:5px 7px;border:0;border-radius:6px;background:${s.enabled ? '#123c8c' : '#555'};color:white;cursor:pointer">${s.enabled ? 'ON' : 'OFF'}</button>
          </div>
          <div style="display:flex;justify-content:space-between;margin:4px 0;font-size:11px;opacity:.85">
            <span>Cycle ${s.cycleTime.toFixed(2)}s • ${s.completedCycles} batches</span>
            <span>${percent}%</span>
          </div>
          <div style="height:5px;background:#3b506f;border-radius:5px;overflow:hidden">
            <div style="height:100%;width:${percent}%;background:#ff6b00"></div>
          </div>
          <button data-flow="upgrade-${index}" style="margin-top:5px;padding:4px 7px;border:1px solid #3e618c;border-radius:6px;background:#17375a;color:white;cursor:pointer;font-size:11px">Improve cycle −10%</button>
        </div>`;
    }).join('');

    buffersElement.innerHTML = `
      Raw → Mixing → <b>Buffer A: ${this.buffers[0]}/${BUFFER_CAPACITY}</b><br>
      Processing → <b>Buffer B: ${this.buffers[1]}/${BUFFER_CAPACITY}</b> → Packaging<br>
      In process: <b>${inProcess}</b> • Simulated time: <b>${Math.floor(this.simulatedSeconds)}s</b>
    `;
    let bottleneckIndex = 0;
    for (let i = 1; i < 3; i++) {
      if (this.stations[i].cycleTime > this.stations[bottleneckIndex].cycleTime) bottleneckIndex = i;
    }
    const theoretical = 60 * this.speed / this.stations[bottleneckIndex].cycleTime;
    capacityElement.textContent = `Slowest station: ${STATION_NAMES[bottleneckIndex]} • theoretical maximum ≈ ${theoretical.toFixed(1)} batches/min at selected speed (all stations ON).`;
    // Reapply consistent styling after generating rows.
    stationsElement.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.style.fontFamily = 'Arial, sans-serif';
    });
  }

  update(delta: number): void {
    // During Simulation, ensure any non-grab mutation cannot move machines off their slots.
    this.factoryPlacement?.updateGrab();
    if (!this.layoutMode) this.smartLayout?.restoreAll();
    if (!this.layoutMode) this.placementGuard?.constrain();
    const safeDelta = Math.min(Math.max(delta, 0), 0.1);
    if (this.running) this.simulate(safeDelta);
    this.productionSync?.onProgress(this.completedProducts);
    this.refreshScene(this.running ? safeDelta : 0);
    this.animateFactoryDetails(this.running ? safeDelta : 0);

    this.spatialMenu?.setState({
      layoutMode: this.layoutMode,
      running: this.running,
      selectedStation: this.selectedStation,
    });
    this.dashboardClock += safeDelta;

    if (this.dashboardClock >= 0.2) {
      this.dashboardClock = 0;
      this.spatialProduction?.sync(this.stations.map(s =>
        !s.enabled ? 'OFF' : s.blocked ? 'BLOCKED' : s.busy ? 'PROCESSING' : 'WAITING'
      ));

      if (!this.uiPointerHeld) {
        this.refreshDashboard();
      }
    }

  }

  destroy(): void {
    this.spatialProduction?.dispose();
    this.spatialProduction = null;
    this.productionSync?.dispose();
    this.productionSync = null;
    this.menuRejectedGrabs.clear();
    this.menuInputBlockUntil = 0;
    this.spatialMenu?.dispose();
    this.spatialMenu = null;
    this.factoryPlacement?.dispose();
    this.factoryPlacement = null;
    document.body.classList.remove('flowspace-layout-mode');
    document.getElementById('flowspace-v4d2-ui-layout')?.remove();
    this.layoutToolbar?.remove();
    this.layoutToolbar = null;
    this.layoutPresets?.dispose();
    this.layoutPresets = null;
    this.machineLibrary?.dispose();
    this.machineLibrary = null;
    this.smartLayout?.dispose();
    this.smartLayout = null;
    this.xrInfo?.dispose();
    this.xrInfo = null;
    this.disposeDesktopSelection?.();
    this.disposeDesktopSelection = null;
    this.inspectorPanel?.remove();
    this.inspectorPanel = null;
    this.panel?.remove();
    this.panel = null;
    document.removeEventListener('pointerdown', this.onUiPointerDown, true);
    window.removeEventListener('pointerup', this.onUiPointerUp, true);
    window.removeEventListener('pointercancel', this.onUiPointerUp, true);
    this.placementGuard = null;
    super.destroy();
  }
}
