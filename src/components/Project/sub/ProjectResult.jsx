import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';
import Navbar from 'components/Navgbar';

import Scene from "app/scene"

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";


const ProjectResult = ({ props }) => {
    const {
        stage,
        setStage,
        page,
        setPage,
    } = props;

    const {
        authenticated,
        setAuthenticated,
        userData,
        setUserData,
        updateUserData,
        authChecked,
        setAuthChecked,
        controllerRef
    } = useSocket();

    const { projectId } = useParams();
    const navigateTo = useNavigate();

    const getProjectDetails = async () => {
        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        const userId = userData.userId;
        const detailName = "full";

        try {
            const projectUrl = `http://localhost:3000/getProjectDetails/${userId}/${projectId}?detail=${detailName}`;
            const response = await fetch(projectUrl, {
                method: 'GET',
                signal: controllerRef.current.signal
            });
            const data = await response.json();
            console.log(data)
            if (data.status === 200) {
                setProjectData(data.project);
            } else {
                alert('Failed to load project details');
            }
        } catch (error) {
            console.log(error);
        }
    }


    useEffect(() => {
        if (authChecked && authenticated) {
            getProjectDetails();
        }

        return () => {
            if (sceneRef.current) {
                sceneRef.current.dispose();
                sceneRef.current = null;
            }
        }
    }, [authenticated]);

    //
    const mainContainer = useRef();
    const fileInput = useRef();
    const resultField = useRef();
    const uploadfield_tooltip = useRef();
    const uploadbtn_tooltip = useRef();

    const depthMinVal = useRef();
    const depthMaxVal = useRef();
    const fxVal = useRef();
    const fyVal = useRef();
    const cxVal = useRef();
    const cyVal = useRef();

    const sceneRef = useRef(null);

    const [projectData, setProjectData] = useState({})
    const [images, setImages] = useState([]);
    const [result, setResult] = useState(null);
    const [downloadUrl, setDownloadUrl] = useState(null);
    const [status, setStatus] = useState("idle");  // ["idle", "processing", "completed"]
    const [resultRetrieved, setResultRetrieved] = useState(false);

    useEffect(() => {
        switch (status) {
            case "idle":
                if (uploadfield_tooltip.current) {
                    uploadfield_tooltip.current.innerHTML = `
                        Drop images here or click to upload
                        <br />
                        Only jpg, jpeg, png files are supported
                    `;
                }
                if (uploadbtn_tooltip.current) {
                    uploadbtn_tooltip.current.innerHTML = `
                        Convert
                    `;
                }
                break;
            case "processing":
                if (uploadfield_tooltip.current) {
                    uploadfield_tooltip.current.innerHTML = `
                        Processing images...
                        <br />
                        Please wait...
                    `;
                }
                if (uploadbtn_tooltip.current) {
                    uploadbtn_tooltip.current.innerHTML = `
                        Processing...
                    `;
                }
                break;
            case "completed":
                if (uploadfield_tooltip.current) {
                    uploadfield_tooltip.current.innerHTML = `
                        Loading result...
                    `;
                }
                if (uploadbtn_tooltip.current) {
                    uploadbtn_tooltip.current.innerHTML = `
                        Upload again
                    `;
                }
                break;
            default:
                console.log("Unknown status");
        }
    }, [status])

    const handleFileUpload = (event) => {
        event.preventDefault();

        setImages(prevImages => [...prevImages, ...Array.from(event.target.files)]);
    }

    const handleRemoveImage = (index) => {
        setImages(prevImages => prevImages.filter((image, i) => i !== index));
    }

    const handleFormSubmit = async (event) => {
        event.preventDefault();

        if (status === "processing")
            return;

        if (status === "completed") {
            resetUpload();
            return;
        }

        if (images.length === 0) {
            return alert("No images were uploaded");
        }

        setStatus("processing");

        console.log(`Requesting ${images.length} images`)

        const formData = new FormData();
        images.forEach((image, index) => {
            formData.append('images', image, image.name);
        });

        // Add extra parameters
        const parameters = {
            depthMin: depthMinVal.current.value,
            depthMax: depthMaxVal.current.value,
            fx: fxVal.current.value,
            fy: fyVal.current.value,
            cx: cxVal.current.value,
            cy: cyVal.current.value
        };

        // Convert parameters to JSON string
        const parametersJson = JSON.stringify(parameters);

        // Append parameters to formData
        formData.append('parameters', parametersJson);

        const userId = 1;
        const projectId = 1;

        const source = new EventSource(`http://localhost:3000/process_image/${userId}/${projectId}`);

        source.onerror = function (error) {
            console.log('EventSource connection error');
            console.error(error)
        };

        await new Promise((resolve, reject) => {
            source.onmessage = function (event) {
                if (event.data === 'READY') {
                    resolve(source);
                } else if (event.data === 'CLOSE') {
                    source.close();
                    resetUpload();
                } else {
                    console.log(`Progress: ${event.data}%`);
                }
            };
        })

        fetch(`http://localhost:3000/process_image/${userId}/${projectId}`, {
            // fetch(`https://3dreconstruction-api.vercel.app/process_image/${userId}/${projectId}`, {
            method: 'POST',
            body: formData
        })
            .then(response => response.json())  // convert the response to JSON
            .then(res => {
                if (res.code === 200) {
                    console.log("Reconstruction success")
                    source.close();
                    fetchResult();
                }
            })
            .catch(error => {
                console.error('Error:', error)
                source.close();
                resetUpload();
            });
    }

    const s3Downloadv3 = async () => {
        const s3client = new S3Client({
            region: import.meta.env.VITE_AWS_REGION,
            credentials: {
                accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
                secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
            }
        });

        const userId = userData.userId;

        const userResultPath = `user-${userId}/${projectId}/output/accumulated_numpy.npy`;

        const params = {
            Bucket: import.meta.env.VITE_AWS_BUCKET_NAME,
            Key: userResultPath,
        }
        const data = await s3client.send(new GetObjectCommand(params));

        const bodyStream = data.Body;
        const bodyAsString = await bodyStream.transformToByteArray();

        console.log(bodyAsString.buffer)

        return bodyAsString.buffer;
    }

    const fetchResult = async () => {

        if (status == "processing")
            return;

        if (status == "idle")
            setStatus("processing");

        console.log("Fetching result...")

        let result = await s3Downloadv3();
        let arrayBuffer = result;
        setResultRetrieved(true);
        setResult(arrayBuffer);
        setStatus("completed");

        console.log("Result fetched.")
    }

    const downloadResult = (type) => {
        var link = document.createElement('a');
        if (type === "npy") {
            link.href = downloadUrl.npyUrl;
            link.download = 'result.npy';
        } else if (type === "gltf") {
            link.href = downloadUrl.gltfUrl;
            link.download = 'result.gltf';
        }
        link.click();
    }

    const resetUpload = () => {
        if (sceneRef.current) {
            sceneRef.current.dispose();
            sceneRef.current = null;
        }
        setResultRetrieved(false)
        setDownloadUrl(null);
        setStatus("idle");
    }

    const handleClick = (event) => {
        if (status === "processing" || status === "completed")
            return;

        fileInput.current.click()
    }

    const handleDragOver = (event) => {
        event.preventDefault();
    }

    const handleDrop = (event) => {
        event.preventDefault();

        if (status === "processing" || status === "completed")
            return;

        let newImages = [...images];  // Create a copy of the current images

        if (event.dataTransfer.items) {
            // Use DataTransferItemList interface to access the file(s)
            for (var i = 0; i < event.dataTransfer.items.length; i++) {
                // If dropped items aren't files, reject them
                if (event.dataTransfer.items[i].kind === 'file') {
                    var file = event.dataTransfer.items[i].getAsFile();
                    var fileType = file.name.split('.').pop().toLowerCase();

                    // Check if file type is jpg, jpeg or png
                    if (fileType === 'jpg' || fileType === 'jpeg' || fileType === 'png') {
                        newImages.push(file);
                    } else {
                        alert("Invalid file type. Please upload only jpg, jpeg or png files.")
                    }
                }
            }
        } else {
            // Use DataTransfer interface to access the file(s)
            for (var i = 0; i < event.dataTransfer.files.length; i++) {
                var fileType = event.dataTransfer.files[i].name.split('.').pop().toLowerCase();

                // Check if file type is jpg, jpeg or png
                if (fileType === 'jpg' || fileType === 'jpeg' || fileType === 'png') {
                    newImages.push(event.dataTransfer.files[i]);
                } else {
                    alert("Invalid file type. Please upload only jpg, jpeg or png files.")
                }
            }
        }
        setImages(newImages);
    }


    const waitResult = async () => {
        console.log("Creating scene...")
        sceneRef.current = new Scene(resultField.current);
        sceneRef.current.init();
        const [gltfUrl, npyUrl] = await sceneRef.current.loadResult(result);
        setDownloadUrl({ gltfUrl, npyUrl });
    }

    useEffect(() => {
        if (resultRetrieved && sceneRef.current == null && status != "idle") {
            waitResult();
        }
    }, [resultRetrieved])

    function formatDate(dateString) {
        const date = new Date(dateString);
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    }

    // =============================================================

    return (
        <>
            <div className="project">
                <div className='project-header'>Project {projectId} - New Project</div>
                <div>Project details</div>
                <table className="styled-table">
                    <thead>
                        <tr>
                            <th>Project Id</th>
                            <th>Project Name</th>
                            <th>Create Date</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>{projectData.projectId}</td>
                            <td>{projectData.projectName}</td>
                            <td>{formatDate(projectData.projectDate)}</td>
                            <td>{projectData.projectStatus}</td>
                        </tr>
                    </tbody>
                </table>
                <div className='project-viewport-container'>
                    <h4>Result Viewport</h4>
                    <div ref={mainContainer} className='rcs-container'>
                        <div className='left-content'>
                            {resultRetrieved ? (
                                <>
                                    <div className='result-field' ref={resultField}></div>
                                </>
                            ) : (
                                <>
                                    <div
                                        className='upload-field'
                                        onDrop={handleDrop}
                                        onDragOver={handleDragOver}
                                        onClick={handleClick}
                                    >
                                        <div style={{ textAlign: 'center' }} ref={uploadfield_tooltip}>
                                        </div>

                                        <input
                                            ref={fileInput}
                                            type="file"
                                            onChange={handleFileUpload}
                                            onClick={(event) => event.target.value = null}
                                            className='file-input'
                                            multiple
                                            accept=".jpg,.jpeg,.png"
                                        />
                                    </div>
                                </>
                            )}
                            <div className='option-field'>
                                {downloadUrl && (
                                    <>
                                        <button onClick={() => downloadResult("npy")}>Download npy</button>
                                        <button onClick={() => downloadResult("gltf")}>Download glTF</button>
                                    </>
                                )}
                                <button onClick={fetchResult}>Result</button>
                                <button onClick={handleFormSubmit} ref={uploadbtn_tooltip}>Convert now</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div className='project-image-container'>
                    <h4>Uploaded Images</h4>
                    <div className="image-container">
                        {images.map((image, index) => (
                            <div className="image-box" key={index} style={{ position: 'relative' }}>
                                <img
                                    src={URL.createObjectURL(image)}
                                    alt={`Uploaded Image ${index}`}
                                    className='uploaded-image'
                                />
                                <div
                                    onClick={() => handleRemoveImage(index)}
                                    className='remove-image-btn'
                                    title="Remove image"
                                >
                                    X
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </>
    )
};

export default ProjectResult;