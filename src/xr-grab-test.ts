
import { Vector3 } from 'three';
import {
    World,
    Mesh,
    BoxGeometry,
    CylinderGeometry,
    MeshBasicMaterial,
    RayInteractable,
    DistanceGrabbable,
    MovementMode
} from '@iwsdk/core';

export function addGrabTestMachine(world: World): void {

    // Main body of the test machine
    const body = new Mesh(
        new BoxGeometry(0.48, 0.48, 0.42),
        new MeshBasicMaterial({ color: 0x123c8c })
    );

    body.position.set(0, 2.65, -2.6);

    // Tank - child of the machine
    const tank = new Mesh(
        new CylinderGeometry(0.19, 0.19, 0.32, 24),
        new MeshBasicMaterial({ color: 0xc0ccd8 })
    );

    tank.position.set(0, 0.36, 0);
    body.add(tank);

    // Orange motor
    const motor = new Mesh(
        new BoxGeometry(0.18, 0.13, 0.18),
        new MeshBasicMaterial({ color: 0xff6b00 })
    );

    motor.position.set(0, 0.59, 0);
    body.add(motor);

    // Status indicator
    const lamp = new Mesh(
        new BoxGeometry(0.12, 0.08, 0.09),
        new MeshBasicMaterial({ color: 0x22c55e })
    );

    lamp.position.set(0.15, 0.1, 0.22);
    body.add(lamp);

    // Register the whole assembly as one entity
    const entity = world.createTransformEntity(body);

    entity.addComponent(RayInteractable);

    entity.addComponent(DistanceGrabbable, {
        translate: true,
        rotate: true,
        scale: false,
        movementMode: MovementMode.MoveFromTarget,
        returnToOrigin: false
    });

    // FlowSpace MR V4-B: Distance controls

    const originalPosition = body.position.clone();

    function moveMachineDistance(amount: number): void {
        const cameraPosition =
            world.camera.getWorldPosition(new Vector3());

        const machinePosition =
            body.getWorldPosition(new Vector3());

        const direction =
            machinePosition.sub(cameraPosition);

        const currentDistance = direction.length();

        if (currentDistance < 0.001) return;

        const newDistance = Math.max(
            1.0,
            Math.min(15.0, currentDistance + amount)
        );

        const movement = direction
            .normalize()
            .multiplyScalar(newDistance - currentDistance);

        body.position.add(movement);
    }

    const controls = document.createElement('div');
    controls.id = 'flowspace-distance-controls';

    controls.style.cssText = `
    position: fixed;
    bottom: 85px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    background: #14243A;
    padding: 12px;
    border: 1px solid #FF6B00;
    border-radius: 10px;
    display: flex;
    gap: 8px;
    font-family: Arial, sans-serif;
  `;

    const actions = [
        { label: 'Closer', distance: -0.5 },
        { label: 'Farther', distance: 0.5 }
    ];

    for (const action of actions) {
        const button = document.createElement('button');
        button.textContent = action.label;

        button.style.cssText = `
      background: #123C8C;
      color: white;
      padding: 9px 14px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
    `;

        button.addEventListener('click', () => {
            moveMachineDistance(action.distance);
        });

        controls.appendChild(button);
    }

    // FlowSpace MR - 360 Degree Rotation


    // FlowSpace MR V4-B
    // Full 3-Axis Rotation: X, Y, Z

    const rotationActions = [
        { label: 'X +15°', axis: 'x', angle: 15 },
        { label: 'X -15°', axis: 'x', angle: -15 },

        { label: 'Y +15°', axis: 'y', angle: 15 },
        { label: 'Y -15°', axis: 'y', angle: -15 },

        { label: 'Z +15°', axis: 'z', angle: 15 },
        { label: 'Z -15°', axis: 'z', angle: -15 }
    ] as const;

    controls.style.flexWrap = 'wrap';
    controls.style.justifyContent = 'center';
    controls.style.width = 'max-content';
    controls.style.maxWidth = 'calc(100vw - 32px)';

    for (const action of rotationActions) {
        const button = document.createElement('button');

        button.textContent = action.label;

        button.style.cssText = `
      background: #FF6B00;
      color: white;
      padding: 9px 12px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: bold;
    `;

        button.addEventListener('click', () => {
            const radians = action.angle * Math.PI / 180;

            if (action.axis === 'x') {
                body.rotateX(radians);
            }

            if (action.axis === 'y') {
                body.rotateY(radians);
            }

            if (action.axis === 'z') {
                body.rotateZ(radians);
            }
        });

        controls.appendChild(button);
    }

    const reset = document.createElement('button');
    reset.textContent = 'Reset Position';

    reset.addEventListener('click', () => {
        body.position.copy(originalPosition);
        body.rotation.set(0, 0, 0);
    });

    controls.appendChild(reset);
    document.getElementById(
        'flowspace-distance-controls'
    )?.remove();

    document.body.appendChild(controls);

}
