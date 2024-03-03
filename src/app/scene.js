import * as THREE from 'three';
import Npyjs from 'npyjs';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

class Scene {
    constructor(container) {
        this.container = container;
        console.log("Binded container", container)
        this.result = null;
    }

    init() {
        const container = this.container;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xffffff); // Set background color to blue

        this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
        this.camera.position.z = 5;

        this.renderer = new THREE.WebGLRenderer();
        this.renderer.setSize(container.clientWidth, container.clientHeight); // Set renderer size to container size
        container.appendChild(this.renderer.domElement);

        var ambientLight = new THREE.AmbientLight(0xffffff);  // white light
        this.scene.add(ambientLight);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);

        this._bind();

        this.animate();
    }

    loadResult(buffer) {
        const npy = new Npyjs();
        const dataAndShape = npy.parse(buffer);  // parse the .npy file
        const points = dataAndShape.data;

        var geometry = new THREE.BufferGeometry();
        var vertices = [];
        var colors = [];

        for (var i = 0; i < points.length; i += 6) {
            // Access the coordinates and colors as elements of the array
            vertices.push(points[i], points[i + 1], points[i + 2]);
            colors.push(points[i + 3], points[i + 4], points[i + 5]);
        }

        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

        var material = new THREE.PointsMaterial({ vertexColors: true, size: 0.001 });
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
    }

    animate() {
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
}

export default Scene;