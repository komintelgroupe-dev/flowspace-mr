
import { Box3, Mesh, Vector3 } from 'three';

export function createFactoryPlacementGuard(machines: Mesh[]) {

    // Allowed movement area
    const minimum = new Vector3(-3.3, 0.9, -5.2);
    const maximum = new Vector3(3.3, 3.1, -0.7);

    // Minimum separation between machines
    const clearance = 0.06;

    // Save last valid positions and rotations
    const safe = machines.map((mesh) => ({
        position: mesh.position.clone(),
        quaternion: mesh.quaternion.clone(),
    }));

    const bounds = machines.map(() => new Box3());

    function recalculateBounds(): void {
        for (let i = 0; i < machines.length; i++) {
            machines[i].updateWorldMatrix(true, true);

            bounds[i]
                .setFromObject(machines[i])
                .expandByScalar(clearance / 2);
        }
    }

    function constrain(): void {
        if (!machines.length) return;

        // Keep machine centers inside the allowed area
        for (const mesh of machines) {
            mesh.position.clamp(minimum, maximum);
        }

        recalculateBounds();

        for (let i = 0; i < machines.length; i++) {
            let overlapping = false;

            for (let j = 0; j < machines.length; j++) {
                if (i !== j && bounds[i].intersectsBox(bounds[j])) {
                    overlapping = true;
                    break;
                }
            }

            if (overlapping) {
                // Return to the last valid position and rotation
                machines[i].position.copy(safe[i].position);
                machines[i].quaternion.copy(safe[i].quaternion);

                machines[i].updateWorldMatrix(true, true);

                bounds[i]
                    .setFromObject(machines[i])
                    .expandByScalar(clearance / 2);
            } else {
                // Remember valid position and rotation
                safe[i].position.copy(machines[i].position);
                safe[i].quaternion.copy(machines[i].quaternion);
            }
        }
    }

    return { constrain };
}
