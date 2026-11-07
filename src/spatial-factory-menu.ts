
/**
 * FlowSpace MR V4-D.2
 * Spatial XR Factory Management
 * Ray interaction for Meta Quest / IWER.
 */
import {
    RayInteractable,
    PokeInteractable,
    Hovered,
    type World
} from '@iwsdk/core';

import {
    BoxGeometry,
    CanvasTexture,
    Group,
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    SRGBColorSpace,
    type Material,
} from 'three';

export type XRMenuFeedback = {
    ok: boolean;
    message: string;
};

type MenuAction =
    | 'toggle-production'
    | 'toggle-layout'
    | 'mixing'
    | 'processing'
    | 'packaging'
    | 'open-tools'
    | 'back'
    | 'save-layout'
    | 'next-layout'
    | 'load-layout'
    | 'store-selected'
    | 'slot-1'
    | 'slot-2'
    | 'slot-3'
    | 'reset-layout';

type MenuState = {
    layoutMode: boolean;
    running: boolean;
    selectedStation: number | null;
};

type MenuHandlers = {
    toggleProduction: () => void;
    toggleLayout: () => void;
    selectStation: (index: number) => void;
    saveLayout: () => XRMenuFeedback;
    nextLayout: () => XRMenuFeedback;
    loadLayout: () => XRMenuFeedback;
    storeSelected: () => XRMenuFeedback;
    placeSelected: (slot: number) => XRMenuFeedback;
    resetLayout: () => XRMenuFeedback;
};

type ButtonView = {
    entity: ReturnType<World['createTransformEntity']>;
    mesh: Mesh;
    texture: CanvasTexture;
    context: CanvasRenderingContext2D;
    canvas: HTMLCanvasElement;
    lastVisual: string;
};

const NAVY = '#14243A';
const BLUE = '#123C8C';
const ORANGE = '#FF6B00';

const MAIN_ACTIONS: MenuAction[] = [
    'toggle-layout',
    'toggle-production',
    'mixing',
    'processing',
    'packaging',
    'open-tools',
];

const TOOL_ACTIONS: MenuAction[] = [
    'save-layout',
    'next-layout',
    'load-layout',
    'store-selected',
    'slot-1',
    'slot-2',
    'slot-3',
    'reset-layout',
    'back',
];

export class SpatialFactoryMenu {

    private lastPressTime = 0;
    private lastPressEntity = -1;
    private readonly pressCooldownMs = 250;

    private shouldIgnorePress(entityIndex: number): boolean {
        const now = performance.now();

        if (
            this.lastPressEntity === entityIndex &&
            now - this.lastPressTime < this.pressCooldownMs
        ) {
            return true;
        }

        this.lastPressEntity = entityIndex;
        this.lastPressTime = now;

        return false;
    }

    private readonly rootEntity:
        ReturnType<World['createTransformEntity']>;

    private readonly buttons: ButtonView[] = [];

    private readonly byEntity =
        new Map<number, MenuAction>();

    /** True while at least one XR/browser pointer is hovering an active menu button. */
    isHoveringButton(): boolean {
        if (this.disposed) return false;
        return this.buttons.some(button =>
            button.mesh.visible &&
            this.byEntity.has(button.entity.index) &&
            button.entity.hasComponent(Hovered)
        );
    }

    private readonly ownedMeshes: Mesh[] = [];
    private readonly ownedTextures: CanvasTexture[] = [];

    private readonly statusCanvas: HTMLCanvasElement;
    private readonly statusContext: CanvasRenderingContext2D;
    private readonly statusTexture: CanvasTexture;

    private readonly subtitleCanvas: HTMLCanvasElement;
    private readonly subtitleContext: CanvasRenderingContext2D;
    private readonly subtitleTexture: CanvasTexture;

    private state: MenuState = {
        layoutMode: false,
        running: false,
        selectedStation: null,
    };

    private page: 'main' | 'tools' = 'main';

    private notice =
        'Point at a button and press Trigger';

    private confirmReset = false;
    private disposed = false;

    constructor(
        private readonly world: World,
        private readonly handlers: MenuHandlers,
    ) {
        const root = new Group();

        root.name = 'FlowSpace-V4D2-Spatial-Menu';

        root.position.set(-2.45, 2.42, -1.30);
        root.scale.setScalar(0.82);
        root.rotation.y = 0.15;

        this.rootEntity =
            world.createTransformEntity(root);

        const bg = new Mesh(
            new PlaneGeometry(1.64, 2.55),
            new MeshBasicMaterial({
                color: 0x14243a,
                side: 2,
                transparent: true,
                opacity: 0.97,
            }),
        );

        bg.position.z = -0.055;
        root.add(bg);
        this.ownedMeshes.push(bg);

        const heading = this.createTextPlane(
            'FLOWSPACE  |  XR CONTROL',
            1.50,
            0.17,
            48,
        );

        heading.mesh.position.set(0, 1.14, 0.006);
        root.add(heading.mesh);

        const subtitle = this.createTextPlane(
            'MAIN CONTROLS',
            1.50,
            0.12,
            43,
        );

        subtitle.mesh.position.set(0, 0.99, 0.008);
        root.add(subtitle.mesh);

        this.subtitleCanvas = subtitle.canvas;
        this.subtitleContext = subtitle.context;
        this.subtitleTexture = subtitle.texture;

        const status = this.createTextPlane(
            this.notice,
            1.50,
            0.20,
            38,
        );

        status.mesh.position.set(0, -1.14, 0.01);
        root.add(status.mesh);

        this.statusCanvas = status.canvas;
        this.statusContext = status.context;
        this.statusTexture = status.texture;

        for (let i = 0; i < TOOL_ACTIONS.length; i++) {
            this.makeButton();
        }

        this.refreshButtons();
    }

    private createTextPlane(
        text: string,
        width: number,
        height: number,
        fontSize: number,
    ) {
        const canvas = document.createElement('canvas');

        canvas.width = 1024;
        canvas.height = 160;

        const context = canvas.getContext('2d');

        if (!context) {
            throw new Error(
                'SpatialFactoryMenu: Canvas 2D is unavailable',
            );
        }

        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;

        const mesh = new Mesh(
            new PlaneGeometry(width, height),
            new MeshBasicMaterial({
                map: texture,
                transparent: false,
            }),
        );

        this.ownedMeshes.push(mesh);
        this.ownedTextures.push(texture);

        this.drawText(
            canvas,
            context,
            texture,
            text,
            '#A9C7ED',
            fontSize,
        );

        return {
            canvas,
            context,
            texture,
            mesh,
        };
    }

    private drawText(
        canvas: HTMLCanvasElement,
        context: CanvasRenderingContext2D,
        texture: CanvasTexture,
        text: string,
        foreground: string,
        fontSize: number,
    ): void {
        context.clearRect(
            0,
            0,
            canvas.width,
            canvas.height,
        );

        context.fillStyle = NAVY;
        context.fillRect(
            0,
            0,
            canvas.width,
            canvas.height,
        );

        context.fillStyle = foreground;
        context.textAlign = 'center';
        context.textBaseline = 'middle';

        context.font =
            `bold ${fontSize}px Arial, sans-serif`;

        context.fillText(
            text,
            canvas.width / 2,
            canvas.height / 2,
            970,
        );

        texture.needsUpdate = true;
    }

    private makeButton(): void {
        const canvas = document.createElement('canvas');
        canvas.width = 1024;
        canvas.height = 160;

        const context = canvas.getContext('2d');

        if (!context) {
            throw new Error(
                'SpatialFactoryMenu: Canvas 2D is unavailable',
            );
        }

        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;

        const side = new MeshBasicMaterial({
            color: 0x284366,
        });

        const front = new MeshBasicMaterial({
            map: texture,
        });

        const materials: Material[] = [
            side,
            side,
            side,
            side,
            front,
            side,
        ];

        const mesh = new Mesh(
            new BoxGeometry(1.46, 0.185, 0.035),
            materials,
        );

        mesh.position.set(0, 0, 0.03);

        this.ownedMeshes.push(mesh);
        this.ownedTextures.push(texture);

        const entity = this.world.createTransformEntity(
            mesh,
            { parent: this.rootEntity },
        );

        entity.addComponent(RayInteractable);
        entity.addComponent(PokeInteractable);

        this.buttons.push({
            entity,
            mesh,
            canvas,
            context,
            texture,
            lastVisual: '',
        });
    }

    private getLabel(action: MenuAction): string {
        switch (action) {
            case 'toggle-layout':
                return this.state.layoutMode
                    ? 'SWITCH TO SIMULATION'
                    : 'SWITCH TO LAYOUT';

            case 'toggle-production':
                return this.state.running
                    ? 'PAUSE PRODUCTION'
                    : 'START PRODUCTION';

            case 'mixing':
                return '1  MIXING';

            case 'processing':
                return '2  PROCESSING';

            case 'packaging':
                return '3  PACKAGING';

            case 'open-tools':
                return 'FACTORY MANAGEMENT  >';

            case 'save-layout':
                return 'SAVE LAYOUT (AUTO NAME)';

            case 'next-layout':
                return 'NEXT SAVED LAYOUT';

            case 'load-layout':
                return 'LOAD SELECTED LAYOUT';

            case 'store-selected':
                return 'STORE SELECTED MACHINE';

            case 'slot-1':
                return 'PLACE SELECTED -> SLOT 1';

            case 'slot-2':
                return 'PLACE SELECTED -> SLOT 2';

            case 'slot-3':
                return 'PLACE SELECTED -> SLOT 3';

            case 'reset-layout':
                return 'RESET DEFAULT LAYOUT';

            case 'back':
                return '<  BACK TO MAIN MENU';
        }
    }

    private refreshButtons(): void {
        if (this.disposed) return;

        const actions =
            this.page === 'main'
                ? MAIN_ACTIONS
                : TOOL_ACTIONS;

        this.byEntity.clear();

        this.buttons.forEach((button, i) => {
            const action = actions[i];

            button.mesh.visible = !!action;

            if (!action) return;

            this.byEntity.set(
                button.entity.index,
                action,
            );

            button.mesh.position.y =
                this.page === 'main'
                    ? 0.69 - i * 0.272
                    : 0.77 - i * 0.215;

            const selected =
                (action === 'mixing' &&
                    this.state.selectedStation === 0) ||
                (action === 'processing' &&
                    this.state.selectedStation === 1) ||
                (action === 'packaging' &&
                    this.state.selectedStation === 2);

            const disabled =
                action === 'toggle-production' &&
                this.state.layoutMode;

            const label = this.getLabel(action);

            const background = disabled
                ? '#465167'
                : selected
                    ? ORANGE
                    : (
                        action === 'toggle-layout' ||
                        action === 'open-tools' ||
                        action === 'save-layout'
                    )
                        ? ORANGE
                        : BLUE;

            const key =
                `${this.page}:${action}:${label}:${background}:${selected}`;

            if (key === button.lastVisual) return;

            button.lastVisual = key;

            const { context: ctx, canvas } = button;

            ctx.clearRect(
                0,
                0,
                canvas.width,
                canvas.height,
            );

            ctx.fillStyle = background;

            ctx.fillRect(
                0,
                0,
                canvas.width,
                canvas.height,
            );

            ctx.strokeStyle = selected
                ? '#FFFFFF'
                : '#6285B7';

            ctx.lineWidth = 6;

            ctx.strokeRect(
                4,
                4,
                canvas.width - 8,
                canvas.height - 8,
            );

            ctx.fillStyle = '#FFFFFF';

            ctx.font =
                'bold 54px Arial, sans-serif';

            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            ctx.fillText(
                label,
                canvas.width / 2,
                84,
                960,
            );

            button.texture.needsUpdate = true;
        });

        this.drawText(
            this.subtitleCanvas,
            this.subtitleContext,
            this.subtitleTexture,
            this.page === 'main'
                ? 'MAIN CONTROLS'
                : 'LAYOUT MANAGEMENT  |  XR',
            '#A9C7ED',
            44,
        );
    }

    private showNotice(
        message: string,
        error = false,
    ): void {
        this.notice = message;

        this.drawText(
            this.statusCanvas,
            this.statusContext,
            this.statusTexture,
            message,
            error ? '#FFB0A1' : '#A5F5C5',
            38,
        );
    }

    handlePressed(entityIndex: number): boolean {
        if (this.disposed) return false;

        const action = this.byEntity.get(entityIndex);

        if (!action) return false;

        if (action !== 'reset-layout') {
            this.confirmReset = false;
        }
        if (this.shouldIgnorePress(entityIndex)) {
            return true;
        }
        switch (action) {
            case 'toggle-production':
                if (this.state.layoutMode) {
                    this.showNotice(
                        'Switch to Simulation Mode first',
                        true,
                    );
                } else {
                    this.handlers.toggleProduction();
                }
                break;

            case 'toggle-layout':
                this.handlers.toggleLayout();
                break;

            case 'mixing':
                this.handlers.selectStation(0);
                break;

            case 'processing':
                this.handlers.selectStation(1);
                break;

            case 'packaging':
                this.handlers.selectStation(2);
                break;

            case 'open-tools':
                if (!this.state.layoutMode) {
                    this.showNotice(
                        'Switch to Layout Mode first',
                        true,
                    );
                } else {
                    this.page = 'tools';
                    this.refreshButtons();
                    this.showNotice(
                        'Choose an action for the selected machine',
                    );
                }
                break;

            case 'back':
                this.page = 'main';
                this.refreshButtons();
                this.showNotice('Main factory controls');
                break;

            default: {
                if (!this.state.layoutMode) {
                    this.showNotice(
                        'Layout Mode required',
                        true,
                    );
                    break;
                }

                let result: XRMenuFeedback;

                switch (action) {
                    case 'save-layout':
                        result = this.handlers.saveLayout();
                        break;

                    case 'next-layout':
                        result = this.handlers.nextLayout();
                        break;

                    case 'load-layout':
                        result = this.handlers.loadLayout();
                        break;

                    case 'store-selected':
                        result = this.handlers.storeSelected();
                        break;

                    case 'slot-1':
                        result = this.handlers.placeSelected(0);
                        break;

                    case 'slot-2':
                        result = this.handlers.placeSelected(1);
                        break;

                    case 'slot-3':
                        result = this.handlers.placeSelected(2);
                        break;

                    case 'reset-layout':
                        if (!this.confirmReset) {
                            this.confirmReset = true;

                            result = {
                                ok: true,
                                message: 'Press RESET again to confirm',
                            };
                        } else {
                            this.confirmReset = false;
                            result = this.handlers.resetLayout();
                        }
                        break;

                    default:
                        result = {
                            ok: false,
                            message: 'Unknown layout command',
                        };
                }

                this.showNotice(
                    result.message,
                    !result.ok,
                );
            }
        }

        return true;
    }

    setState(next: MenuState): void {
        if (this.disposed) return;

        const changed =
            next.layoutMode !== this.state.layoutMode ||
            next.running !== this.state.running ||
            next.selectedStation !==
            this.state.selectedStation;

        this.state = { ...next };

        if (!next.layoutMode && this.page === 'tools') {
            this.page = 'main';
            this.showNotice('Simulation Mode active');
        }

        if (changed) {
            this.refreshButtons();
        }
    }

    dispose(): void {
        if (this.disposed) return;

        this.disposed = true;
        this.byEntity.clear();

        for (const button of this.buttons) {
            button.entity.dispose();
        }

        this.buttons.length = 0;
        this.rootEntity.dispose();

        const materials = new Set<Material>();

        for (const mesh of this.ownedMeshes) {
            mesh.geometry.dispose();

            const list = Array.isArray(mesh.material)
                ? mesh.material
                : [mesh.material];

            for (const material of list) {
                materials.add(material);
            }
        }

        materials.forEach((material) => {
            material.dispose();
        });

        for (const texture of this.ownedTextures) {
            texture.dispose();
        }
    }
}
