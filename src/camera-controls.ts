
import type { World } from '@iwsdk/core';

export function setupFactoryCamera(world: World): void {
    const canvas = document.querySelector<HTMLCanvasElement>(
        '#scene-container canvas'
    );

    if (!canvas) {
        console.warn('FlowSpace: 3D canvas not found');
        return;
    }

    const camera = world.camera;

    // Center of the factory
    const target = {
        x: 0,
        y: 1.25,
        z: -2.65
    };

    let distance = 6.5;
    let angle = 0;
    let elevation = 0.25;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    // Browser controls only; XR owns the headset camera.
    function isDesktop(): boolean {
        return world.visibilityState.value === 'non-immersive';

    }

    function updateCamera(): void {
        if (!isDesktop()) return;

        camera.position.set(
            target.x + distance * Math.sin(angle) * Math.cos(elevation),
            target.y + distance * Math.sin(elevation),
            target.z + distance * Math.cos(angle) * Math.cos(elevation)
        );

        camera.lookAt(target.x, target.y, target.z);
    }

    canvas.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !isDesktop()) return;
        dragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
    });

    window.addEventListener('pointerup', () => {
        dragging = false;
    });

    canvas.addEventListener('pointermove', (event) => {
        if (!dragging || !isDesktop()) return;

        const dx = event.clientX - lastX;
        const dy = event.clientY - lastY;

        angle -= dx * 0.005;
        elevation = Math.max(
            -0.15,
            Math.min(1.25, elevation + dy * 0.005)
        );

        lastX = event.clientX;
        lastY = event.clientY;
        updateCamera();
    });

    canvas.addEventListener('wheel', (event) => {
        if (!isDesktop()) return;

        event.preventDefault();

        distance = Math.max(
            2.5,
            Math.min(12, distance + event.deltaY * 0.005)
        );

        updateCamera();
    }, { passive: false });

    // Reset camera button
    const resetButton = document.createElement('button');
    resetButton.textContent = 'Reset Camera';
    resetButton.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 9999;
    padding: 12px 18px;
    background: #123C8C;
    color: white;
    border: 1px solid #FF6B00;
    border-radius: 9px;
    cursor: pointer;
    font-weight: bold;
  `;

    resetButton.addEventListener('click', () => {
        distance = 6.5;
        angle = 0;
        elevation = 0.25;
        updateCamera();
    });

    document.body.appendChild(resetButton);
    updateCamera();
}
