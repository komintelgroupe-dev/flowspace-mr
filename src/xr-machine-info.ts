import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { World } from '@iwsdk/core';

export interface MachineInfo {
  name: string;
  status: string;
  cycle: number;
  batches: number;
  progress: number;
}

// The 3D label follows the current world-space position of the selected machine.
export function createXRMachineInfo(world: World) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const geometry = new PlaneGeometry(1.15, 0.58);
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: 2, // DoubleSide; visible from front/back while testing XR.
  });
  const panel = new Mesh(geometry, material);
  panel.visible = false;
  panel.renderOrder = 100;
  world.createTransformEntity(panel);

  const defaultX = [-1.55, 0, 1.55];
  return {
    show(index: number, info: MachineInfo, anchor?: Vector3) {
      if (index < 0 || index > 2) return;
      if (anchor) {
        panel.position.set(anchor.x, anchor.y + 1.5, anchor.z + 0.28);
      } else {
        panel.position.set(defaultX[index], 2.85, -2.6);
      }

      ctx.clearRect(0, 0, 512, 256);
      ctx.fillStyle = '#14243A';
      ctx.beginPath();
      ctx.roundRect(0, 0, 512, 256, 22);
      ctx.fill();
      ctx.fillStyle = '#FF6B00';
      ctx.fillRect(22, 20, 7, 48);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 34px Arial';
      ctx.fillText(info.name, 45, 56);
      ctx.font = '25px Arial';
      ctx.fillStyle = info.status === 'OFF' ? '#EF4444'
        : info.status === 'BLOCKED' ? '#FF6B00' : '#22C55E';
      ctx.fillText(info.status, 28, 103);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '23px Arial';
      ctx.fillText(`Cycle: ${info.cycle.toFixed(2)}s`, 28, 145);
      ctx.fillText(`Batches: ${info.batches}`, 28, 182);
      ctx.fillText(`Progress: ${info.progress}%`, 28, 219);
      texture.needsUpdate = true;
      panel.visible = true;
    },
    hide() { panel.visible = false; },
    dispose() {
      panel.removeFromParent();
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
