/**
 * FlowSpace MR V6.1 — visual-only industrial mixing-machine upgrade.
 * Keeps the existing ECS machine Mesh, RayInteractable and DistanceGrabbable.
 * The GLB is a child of the existing machine root, so it follows layout,
 * save/load, slot swapping, scale and Grab/Rotation without changing physics.
 */
import {
  AmbientLight,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class IndustrialMixingVisual {
  private disposed = false;
  private model: Group | null = null;
  private rotor: Object3D | null = null;
  private readonly originalVisibility = new Map<Object3D, boolean>();
  private readonly lightGroup = new Group();
  private readonly oldMaterialState: {
    opacity: number;
    transparent: boolean;
    depthWrite: boolean;
  };

  constructor(
    private readonly machineBody: Mesh,
    private readonly keepVisible: readonly Object3D[],
  ) {
    const basic = machineBody.material as MeshBasicMaterial;
    this.oldMaterialState = {
      opacity: basic.opacity,
      transparent: basic.transparent,
      depthWrite: basic.depthWrite,
    };

    // Only load the optional artwork. If it fails, preserve the V5.3 visuals.
    const loader = new GLTFLoader();
    loader.load(
      '/models/mixing-v6.glb',
      (gltf) => {
        if (this.disposed) {
          this.disposeLoadedScene(gltf.scene);
          return;
        }

        // GLB uses Y-up; the scene's origin is at the mixer floor.
        const model = gltf.scene;
        model.name = 'FlowSpace-V6-Mixing-Industrial-Visual';
        model.position.set(0, -0.415, 0);
        this.machineBody.add(model);
        this.model = model;
        this.rotor = model.getObjectByName('Mixing_Rotor') ?? null;
        if (!this.rotor) {
          console.warn('V6.1: GLB has no Mixing_Rotor node; static mixer will still work.');
        }

        // The original body remains ray/grab interactable but its cube is hidden.
        // Keep status LEDs, progress bars, and workpieces from the simulation.
        const preserved = new Set(this.keepVisible);
        for (const child of [...this.machineBody.children]) {
          if (child === model || preserved.has(child)) continue;
          this.originalVisibility.set(child, child.visible);
          child.visible = false;
        }

        const material = this.machineBody.material as MeshBasicMaterial;
        material.transparent = true;
        material.opacity = 0;
        material.depthWrite = false;
        material.needsUpdate = true;

        // Existing factory meshes use MeshBasicMaterial; glTF's physically based
        // materials benefit from modest supplemental local lighting.
        const fill = new AmbientLight(0xffffff, 0.85);
        const key = new DirectionalLight(0xffffff, 1.8);
        key.position.set(1.7, 3.2, 2.0);
        this.lightGroup.add(fill, key);
        this.machineBody.add(this.lightGroup);

        console.info('FlowSpace V6.1: industrial mixing GLB loaded.');
      },
      undefined,
      (error) => {
        if (!this.disposed) {
          console.warn('V6.1 model could not load; existing mixing visuals preserved.', error);
        }
      },
    );
  }

  update(running: boolean, delta: number): void {
    if (this.disposed || !running || !this.rotor) return;
    this.rotor.rotation.y += Math.min(Math.max(delta, 0), 0.1) * 2.1;
  }

  private disposeLoadedScene(root: Object3D): void {
    root.traverse((obj) => {
      if (!(obj instanceof Mesh)) return;
      obj.geometry.dispose();
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) {
        // GLTFLoader may use shared maps; dispose each map only after model removal.
        for (const key of ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap'] as const) {
          const texture = (material as unknown as Record<string, { dispose?: () => void }>)[key];
          texture?.dispose?.();
        }
        material.dispose();
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rotor = null;
    if (this.model) {
      this.machineBody.remove(this.model);
      this.disposeLoadedScene(this.model);
      this.model = null;
    }
    this.machineBody.remove(this.lightGroup);
    this.lightGroup.clear();
    for (const [object, visible] of this.originalVisibility) object.visible = visible;
    this.originalVisibility.clear();
    const material = this.machineBody.material as MeshBasicMaterial;
    material.opacity = this.oldMaterialState.opacity;
    material.transparent = this.oldMaterialState.transparent;
    material.depthWrite = this.oldMaterialState.depthWrite;
    material.needsUpdate = true;
  }
}
