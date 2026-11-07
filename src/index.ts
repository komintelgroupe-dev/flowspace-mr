/** FlowSpace MR V2 entry point. Keep the IWS SDK world/bootstrap unchanged. */
/**import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { FactorySystem } from './factory.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
)
  .then((world) => {
    world.registerSystem(FactorySystem);
  })
  .catch((error) => console.error('FlowSpace MR initialization failed:', error));*/

//import { addGrabTestMachine } from './xr-grab-test.js';
import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { FactorySystem } from './factory.js';
import { setupFactoryCamera } from './camera-controls.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions
)
  .then((world) => {
    world.registerSystem(FactorySystem);
    //addGrabTestMachine(world);

    // FlowSpace MR V3-C: Desktop camera controls
    setupFactoryCamera(world);
  })
  .catch((error) => {
    console.error('FlowSpace MR initialization failed:', error);
  });

