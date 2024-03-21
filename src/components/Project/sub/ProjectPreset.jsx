import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';


const ProjectPreset = ({ props }) => {
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

    const s3Downloadv3 = async (userData) => {
        const s3client = new S3Client({
            region: import.meta.env.VITE_AWS_REGION,
            credentials: {
                accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
                secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
            }
        });

        const userId = userData.userId;
        const projectId = userData.projectId;

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

        const params = {
            userId: 1,
            projectId: 1
        }

        let result = await s3Downloadv3(params);
        let arrayBuffer = result;
        setResultRetrieved(true);
        setResult(arrayBuffer);
        setStatus("completed");

        console.log("Result fetched.")
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

    const gotoNextStage = () => {
        setStage(3);
    }

    // =============================================================

    return (
        <>
            <div id="project-preset" className="project-field">
                <div className='project-header'>
                    <span>Step 2. Configure Parameters (Optional)</span>
                    <div id="upload-guide" className="guide" title="View Guideline">?</div>
                </div>

                <div className='preset-form'>
                    <div className='rcs-parameter'>
                        <div className='rp-content'>
                            <div className='rp-item'>
                                <div>Object Depth</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>min</label>
                                        <input className='halfInput' type='number' step="0.01" ref={depthMinVal} defaultValue={0} />
                                    </div>
                                    <div className='halfText'>
                                        <label>max</label>
                                        <input className='halfInput' type='number' step="0.01" ref={depthMaxVal} defaultValue={0} />
                                    </div>
                                </div>
                            </div>
                            <div className='rp-item'>
                                <div>Camera focal length</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>fx</label>
                                        <input className='halfInput' type='number' step="0.01" ref={fxVal} defaultValue={0} />
                                    </div>
                                    <div className='halfText'>
                                        <label>fy</label>
                                        <input className='halfInput' type='number' step="0.01" ref={fyVal} defaultValue={0} />
                                    </div>
                                </div>
                            </div>
                            <div className='rp-item'>
                                <div>Image center position</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>cx</label>
                                        <input className='halfInput' type='number' step="0.01" ref={cxVal} defaultValue={0} />
                                    </div>
                                    <div className='halfText'>
                                        <label>cy</label>
                                        <input className='halfInput' type='number' step="0.01" ref={cyVal} defaultValue={0} />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="submit-field">
                    <div id="next-btn" className="btn buttonFilled" onClick={gotoNextStage}>Next</div>
                </div>
            </div>
        </>
    )
};

export default ProjectPreset;