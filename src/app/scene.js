import * as THREE from 'three';
import Npyjs from 'npyjs';
import * as dat from 'dat.gui';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js';


class Scene {
    constructor(container) {
        this.container = container;
        this.result = null;
        this.shouldAnimate = true;
    }

    init() {
        const container = this.container;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xadd8e6); // Set background color to warm light blue

        this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
        this.camera.position.z = 5;

        this.renderer = new THREE.WebGLRenderer();
        this.renderer.setSize(container.clientWidth, container.clientHeight); // Set renderer size to container size
        container.appendChild(this.renderer.domElement);

        var size = 10;
        var divisions = 150;
        this.gridHelper = new THREE.GridHelper(size, divisions);
        this.scene.add(this.gridHelper);

        // var ambientLight = new THREE.AmbientLight(0xffffff);  // white light
        // this.scene.add(ambientLight);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this.gui = new dat.GUI({ autoPlace: false });
        this.guiControls = {
            showGrids: true
        };

        this.gui.add(this.guiControls, 'showGrids').onChange((value) => {
            this.gridHelper.visible = value;
        });

        // Get the dat.GUI's domElement and position it within the container
        this.gui.domElement.style.position = 'absolute';
        this.gui.domElement.style.right = '0px';
        this.gui.domElement.style.top = '0px';

        this.container.appendChild(this.gui.domElement);

        this._bind();

        this.animate();
    }

    toggleGridHelper() {
        this.gridHelper.visible = !this.gridHelper.visible;
    }

    loadResult(buffer) {
        return new Promise((resolve, reject) => {
            const npy = new Npyjs();
            const dataAndShape = npy.parse(buffer);  // parse the .npy file
            const points = dataAndShape.data;

            var geometry = new THREE.BufferGeometry();
            var vertices = [];
            var vertices_vector = [];
            var colors = [];

            for (var i = 0; i < points.length; i += 6) {
                // Access the coordinates and colors as elements of the array            
                if (points[i] !== null && points[i + 1] !== null && points[i + 2] !== null)
                    vertices_vector.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]));

                vertices.push(points[i], points[i + 1], points[i + 2]);
                colors.push(points[i + 3], points[i + 4], points[i + 5]);
            }

            var material = new THREE.PointsMaterial({ vertexColors: true, size: 0.001 });
            // var geometry = new ConvexGeometry(vertices_vector);

            geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
            geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

            // var material = new THREE.MeshBasicMaterial({ vertexColors: true});
            // var pointCloud = new THREE.Mesh(geometry, material);
            var pointCloud = new THREE.Points(geometry, material);
            this.scene.add(pointCloud);
            this.result = pointCloud;

            // Calculate the camera position
            var cameraPosition = new THREE.Vector3(this.camera.position.x, this.camera.position.y, this.camera.position.z);

            // Initialize the minimum distance to a large value
            var minDistance = Infinity;
            var closestPoint = null;

            // Iterate over all points
            for (var i = 0; i < vertices.length; i += 3) {
                var point = new THREE.Vector3(vertices[i], vertices[i + 1], vertices[i + 2]);
                var distance = cameraPosition.distanceTo(point);

                // If this point is closer to the camera, update the minimum distance and the closest point
                if (distance < minDistance) {
                    minDistance = distance;
                    closestPoint = point;
                }
            }

            // Calculate the direction from the closest point to the camera
            var direction = new THREE.Vector3().subVectors(cameraPosition, closestPoint).normalize();

            // Calculate the new camera position
            var newCameraPosition = new THREE.Vector3().copy(closestPoint).add(direction.multiplyScalar(0.5));

            // Set the camera position
            this.camera.position.set(newCameraPosition.x, newCameraPosition.y, newCameraPosition.z);

            // var exporter = new PLYExporter();

            // exporter.parse(pointCloud, function (gltf) {
            // // Export the mesh to a glTF file
            var exporter = new GLTFExporter();
            exporter.parse(pointCloud, function (gltf) {
                var gltfString = JSON.stringify(gltf);

                // GLTF download
                var blob = new Blob([gltfString], { type: 'model/gltf-binary' });
                var gltfUrl = URL.createObjectURL(blob);

                // NPY download
                var npyBlob = new Blob([buffer], { type: 'application/octet-stream' });
                var npyUrl = URL.createObjectURL(npyBlob);

                console.log("Exported successfully")
                resolve([gltfUrl, npyUrl]);
            });
        })
    }

    animate() {
        if (!this.shouldAnimate)
            return;

        requestAnimationFrame(this.animate.bind(this));

        this.controls.update();

        this.renderer.render(this.scene, this.camera);
    }

    _bind() {
        window.addEventListener('resize', this.onWindowResize.bind(this), false);
    }

    _unbind() {
        window.removeEventListener('resize', this.onWindowResize.bind(this), false);
    }

    onWindowResize() {
        this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }

    dispose() {
        console.log("Disposing scene...")
        this.shouldAnimate = false;
        this._unbind();
        this.gui.destroy();
        this.gui.domElement.remove();
        this.renderer.domElement.remove();
        console.log("Scene disposed")
    }
}

export default Scene;