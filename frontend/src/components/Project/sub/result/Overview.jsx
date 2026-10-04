import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';

import { S3Client, GetObjectCommand, ListObjectsCommand } from "@aws-sdk/client-s3";
import "../css/ProjectResult.css"

const Reminder = ({ status }) => {
    return (
        <div className={`reminder ${status}`}>
            {status === 'loading' && 'Loading...'}
            {status === 'resetting' && 'Resetting...'}
            {status === 'updating' && 'Updating...'}
            {status === 'success' && 'Updated successfully!'}
            {status === 'error' && 'Update failed.'}
        </div>
    );
};

const Overview = ({ projectData }) => {
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

    useEffect(() => {
        if (authChecked && authenticated) {
            retrieveImages("init");
        }
    }, [authChecked, authenticated]);

    const depthMinVal = useRef();
    const depthMaxVal = useRef();
    const fxVal = useRef();
    const fyVal = useRef();
    const cxVal = useRef();
    const cyVal = useRef();
    const epsVal = useRef();
    const minPtsVal = useRef();

    const projectController = useRef();
    const configController = useRef();

    const [openConfigGuide, setOpenConfigGuide] = useState(false);
    const [openImgGuide, setOpenImgGuide] = useState(false);

    const [updateImageStatus, setUpdateImageStatus] = useState(null);
    const [updateConfigStatus, setUpdateConfigStatus] = useState(null);
    const [images, setImages] = useState([]);
    const [config, setConfig] = useState(projectData.projectConfig);

    const [imgEdit, setImgEdit] = useState(false);
    const [configEdit, setConfigEdit] = useState(false);

    const s3Downloadv3 = async () => {

        const s3client = new S3Client({
            region: import.meta.env.VITE_AWS_REGION,
            credentials: {
                accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
                secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
            }
        });

        const userId = userData.userId;

        const userImagePath = `user-${userId}/${projectId}/rgb`;

        const listParams = {
            Bucket: import.meta.env.VITE_AWS_BUCKET_NAME,
            Prefix: userImagePath,
        };
        const listData = await s3client.send(new ListObjectsCommand(listParams));

        if (!listData.Contents) {
            console.log("There are no images uploaded in this project.")
            return [];
        }

        const images = await Promise.all(listData.Contents.map(async (file) => {
            const getParams = {
                Bucket: import.meta.env.VITE_AWS_BUCKET_NAME,
                Key: file.Key,
            };
            const getData = await s3client.send(new GetObjectCommand(getParams));

            const bodyStream = getData.Body;
            const bodyAsString = await bodyStream.transformToByteArray();
            const blob = new Blob([bodyAsString.buffer], { type: 'image/jpeg' });
            const fileName = file.Key.split("/").slice(-1)[0];
            const imageFile = new File([blob], fileName, { type: 'image/jpeg' });
            return imageFile;
        }));

        return images;
    }

    const retrieveConfig = async () => {
        setUpdateConfigStatus('resetting');

        if (configController.current)
            configController.current.abort();

        configController.current = new AbortController();

        const userId = userData.userId;
        const projectId = projectData.projectId;
        const detailName = "config";

        try {
            const backendURL = import.meta.env.VITE_BACKEND_URL;
            const projectUrl = `${backendURL}/getProjectDetails/${userId}/${projectId}?detail=${detailName}`;
            const response = await fetch(projectUrl, {
                method: 'GET',
                signal: configController.current.signal
            });
            const data = await response.json();
            console.log(data)
            if (data.status === 200) {
                console.log("Configuration updated")
                setConfig(data.projectConfig)
                setUpdateConfigStatus(null);
            } else {
                console.log("Error: Restart failed")
            }
        } catch (error) {
            console.log(error);
        }
    }

    const retrieveImages = async (type) => {
        if (type == "init")
            setUpdateImageStatus('loading');
        else if (type == "reset")
            setUpdateImageStatus('resetting');

        try {
            let images = await s3Downloadv3();
            setImages(images);
            setUpdateImageStatus(null);
            console.log("Images fetched.")
        } catch (error) {
            if (error.name === 'NoSuchKey') {
                console.log("File not found:", error);
                setError(true);
            } else {
                console.log("Error getting file:", error);
            }
        }
    }

    function formatDate(dateString) {
        const date = new Date(dateString);
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    }

    const updateProject = async (event, action) => {
        event.target.disabled = true;

        if (action === "restart") {
            let warningText = `Please ensure the source images and configuration are updated.\nOtherwise the result will be the similar.`;

            if (confirm(warningText) != true) {
                event.target.disabled = false;
                return;
            }
        }

        if (action === "config") {
            setUpdateConfigStatus('updating');
        } else if (action === "image") {
            setUpdateImageStatus('updating');
        }

        if (projectController.current)
            projectController.current.abort();

        projectController.current = new AbortController();

        const userId = userData.userId;
        const projectId = projectData.projectId;
        const formData = new FormData();
        formData.append('userId', userId);
        formData.append('projectId', projectId);
        formData.append('action', action);

        if (action === "config") {
            formData.append('config', JSON.stringify(config));
        } else if (action === "image") {
            images.forEach((image, index) => {
                formData.append('images', image, image.name);
            });
        }

        try {
            const backendURL = import.meta.env.VITE_BACKEND_URL;
            const projectUrl = `${backendURL}/projectUpdate`;
            const response = await fetch(projectUrl, {
                method: 'POST',
                body: formData,
                signal: projectController.current.signal
            });
            const data = await response.json();
            console.log(data)
            if (data.status === 200) {
                if (action === "restart") {
                    navigateTo('/projects');
                } else if (action === "image") {
                    console.log("Images updated")
                    setImgEdit(false);
                    setUpdateImageStatus('success');
                } else if (action === "config") {
                    console.log("Configuration updated")
                    setConfigEdit(false);
                    setUpdateConfigStatus('success');
                }
            } else {
                console.log("Error: Restart failed")
                if (action === "image") {
                    setUpdateImageStatus('error');
                } else if (action === "config") {
                    setUpdateConfigStatus('error');
                }
            }
        } catch (error) {
            console.log(error);
            event.target.disabled = false;
        }
    }

    function renameFile(newFile, existingFileNames) {
        let newFileName = newFile.name;

        if (existingFileNames.includes(newFileName)) {
            const fileNameParts = newFileName.split('.');
            const fileExtension = fileNameParts.pop();
            const fileName = fileNameParts.join('.');
            newFileName = `${fileName}_1.${fileExtension}`;
            let count = 2;

            while (existingFileNames.includes(newFileName)) {
                newFileName = `${fileName}_${count}.${fileExtension}`;
                count++;
            }
        }

        return new File([newFile], newFileName, { type: newFile.type });
    }

    const handleDragOver = (event) => {
        event.preventDefault();
    }

    const handleDrop = (event) => {
        event.preventDefault();
        if (!imgEdit) return;

        let newImages = [...images];  // Create a copy of the current images
        let existingFileNames = images.map(file => file.name);

        if (event.dataTransfer.items) {
            // Use DataTransferItemList interface to access the file(s)
            for (var i = 0; i < event.dataTransfer.items.length; i++) {
                // If dropped items aren't files, reject them
                if (event.dataTransfer.items[i].kind === 'file') {
                    var file = event.dataTransfer.items[i].getAsFile();
                    var fileType = file.name.split('.').pop().toLowerCase();

                    // Check if file type is jpg, jpeg or png
                    if (fileType === 'jpg' || fileType === 'jpeg' || fileType === 'png') {
                        const renamedFile = renameFile(file, existingFileNames);
                        newImages.push(renamedFile);
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
                    const renamedFile = renameFile(event.dataTransfer.files[i], existingFileNames);
                    newImages.push(renamedFile);
                } else {
                    alert("Invalid file type. Please upload only jpg, jpeg or png files.")
                }
            }
        }
        setImages(newImages);
    }

    const handleAddImage = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.jpg,.jpeg,.png';
        input.onchange = (event) => {
            const newFiles = Array.from(event.target.files);
            const existingFileNames = images.map(file => file.name);
            const renamedFiles = newFiles.map(newFile => renameFile(newFile, existingFileNames));

            setImages(prevImages => [...prevImages, ...renamedFiles]);
        };
        input.click();
    }

    const handleRemoveImage = (index) => {
        setImages(prevImages => prevImages.filter((image, i) => i !== index));
    }

    const handleInputChange = (event, field) => {
        const value = event.target.value;
        setConfig(prevConfig => ({ ...prevConfig, [field]: value }));
    };

    const cancelEditConfig = () => {
        setConfigEdit(false);
        retrieveConfig("reset");
    }

    const cancelEditImg = () => {
        setImgEdit(false);
        retrieveImages("reset");
    }

    // =============================================================

    return (
        <>
            <div id="project-overview" className="background-field">
                <div className='overview-section'>
                    <div className='section-title'>Details</div>
                    <table className="styled-table">
                        <thead>
                            <tr>
                                <th>Project Name</th>
                                <th>Create Date</th>
                                <th>Progress</th>
                                <th>Status</th>
                                <th>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>{projectData.projectName}</td>
                                <td>{formatDate(projectData.projectDate)}</td>
                                <td>{projectData.projectProgress}%</td>
                                <td>{projectData.projectStatus.charAt(0).toUpperCase() + projectData.projectStatus.slice(1)}</td>
                                <td><div className='btn' onClick={(event) => updateProject(event, "restart")}>Restart</div></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div className='overview-config overview-section'>
                    <div className="section-header">
                        <div className='section-title'>
                            <span>Configuration</span>
                            <div id="upload-guide" className="guide" title="View Guideline" onClick={() => setOpenConfigGuide(true)}>?</div>
                            {updateConfigStatus && <Reminder status={updateConfigStatus} key={updateConfigStatus} />}
                        </div>
                        {updateConfigStatus == null && (
                            !configEdit ? (
                                <div className='section-btn' onClick={() => setConfigEdit(true)}>Edit</div>
                            ) : (
                                <div>
                                    <div className='section-btn' onClick={cancelEditConfig}>Cancel</div>
                                    <div className='section-btn' onClick={(event) => updateProject(event, "config")}>Save</div>
                                </div>
                            )
                        )}
                    </div>
                    <div className='rcs-parameter'>
                        <div className='overview-config-wrapper'>
                            <div className='rp-item'>
                                <div>Object Depth</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>min</label>
                                        <input className='halfInput' type='number' step="0.01"
                                            ref={depthMinVal}
                                            value={config.depthMin}
                                            onChange={e => handleInputChange(e, 'depthMin')}
                                            disabled={!configEdit}
                                        />
                                    </div>
                                    <div className='halfText'>
                                        <label>max</label>
                                        <input className='halfInput' type='number' step="0.01"
                                            ref={depthMaxVal}
                                            value={config.depthMax}
                                            onChange={e => handleInputChange(e, 'depthMax')}
                                            disabled={!configEdit}
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className='rp-item'>
                                <div>Camera focal length</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>fx</label>
                                        <input className='halfInput' type='number' step="0.01"
                                            ref={fxVal}
                                            value={config.fx}
                                            onChange={e => handleInputChange(e, 'fx')}
                                            disabled={!configEdit} />
                                    </div>
                                    <div className='halfText'>
                                        <label>fy</label>
                                        <input className='halfInput' type='number' step="0.01"
                                            ref={fyVal}
                                            value={config.fy}
                                            onChange={e => handleInputChange(e, 'fy')}
                                            disabled={!configEdit}
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className='rp-item'>
                                <div>Image center position</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>cx</label>
                                        <input className='halfInput' type='number' step="0.01"
                                            ref={cxVal}
                                            value={config.cx}
                                            onChange={e => handleInputChange(e, 'cx')}
                                            disabled={!configEdit}
                                        />
                                    </div>
                                    <div className='halfText'>
                                        <label>cy</label>
                                        <input className='halfInput' type='number' step="0.01"
                                            ref={cyVal}
                                            value={config.cy}
                                            onChange={e => handleInputChange(e, 'cy')}
                                            disabled={!configEdit}
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className='rp-item'>
                                <div>Cluster filtering</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>eps threshold</label>
                                        <input className='halfInput' type='number' step="0.01"
                                            ref={epsVal}
                                            value={config.eps}
                                            onChange={e => handleInputChange(e, 'eps')}
                                            disabled={!configEdit}
                                        />
                                    </div>
                                    <div className='halfText'>
                                        <label>min points</label>
                                        <input className='halfInput' type='number' step="0.01"
                                            ref={minPtsVal}
                                            value={config.minPts}
                                            onChange={e => handleInputChange(e, 'minPts')}
                                            disabled={!configEdit}
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className='overview-image overview-section'>
                    <div className="section-header">
                        <div className='section-title'>
                            <span>Source Images</span>
                            <div id="upload-guide" className="guide" title="View Guideline" onClick={() => setOpenImgGuide(true)}>?</div>
                            {updateImageStatus && <Reminder status={updateImageStatus} key={updateImageStatus} />}
                        </div>
                        {updateImageStatus == null && (
                            !imgEdit ? (
                                <div className='section-btn' onClick={() => setImgEdit(true)}>Edit</div>
                            ) : (
                                <div>
                                    <div className='section-btn' onClick={cancelEditImg}>Cancel</div>
                                    <div className='section-btn' onClick={(event) => updateProject(event, "image")}>Save</div>
                                </div>
                            )
                        )}
                    </div>
                    <div className="image-container"
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                    >
                        {images.map((image, index) => (
                            <div className="image-box" key={index} style={{ position: 'relative' }}>
                                <img
                                    src={URL.createObjectURL(image)}
                                    alt={`${image.name}`}
                                    title={`${image.name}`}
                                    className='uploaded-image'
                                />
                                {imgEdit && (
                                    <div
                                        onClick={() => handleRemoveImage(index)}
                                        className='remove-image-btn'
                                        title={`Remove ${image.name}`}
                                    >
                                        -
                                    </div>
                                )}
                            </div>
                        ))}
                        {imgEdit && (
                            <div id="upload-extra" className="image-box" onClick={handleAddImage}>
                                +
                            </div>
                        )}
                    </div>
                </div>
            </div >

            {openConfigGuide && (
                <div className='guide-wrapper' onClick={() => setOpenConfigGuide(false)}>
                    <div className='guide-container' onClick={(e) => e.stopPropagation()}>
                        <div className='guide-header'>
                            <span>Configuring Guideline</span>
                            <div
                                className='guide-close pointer'
                                onClick={() => setOpenConfigGuide(false)}
                            >
                                &#10060;
                            </div>
                        </div>
                        <div className='guide-content'>
                            <div>
                                <div>1. If you're unsure about your camera's intrinsic and extrinsic parameters, feel free to skip for now.</div>
                                <div>You can always fine-tune these settings in your next attempt.</div>
                            </div>
                            <hr />
                            <div>2. Fine-tuning your settings</div>
                            <div>
                                <div><strong>- What is object depth? -</strong></div>
                                <div>
                                    <img id="depth_showcase" src="/3dreconstruction/image/depth_showcase.png" title="Object depth showcase" />
                                    <div>Object depth refers to the distance between the camera and the object in the scene.</div>
                                    <div>Depth Min = Depth Max - Object depth</div>
                                    <div>A well configured depth min and max can effectively address the coarseness of the result point cloud.</div>
                                </div>
                            </div>
                            <hr />
                            <div>
                                <div><strong>- What is focal length and how do i find it? -</strong></div>
                                <div>The focal length of a camera lens refers to the distance between the lens and the image sensor.</div>
                                <div>It's usually stated in millimeters (mm). You need to multiply the value by 10 before use.</div>
                                <div>Example:</div>
                                <div>Samsung Galaxy Note 10+ Default camera focal length = 52mm</div>
                                <div>fx = fy = 520</div>
                                <div>
                                    <img id="fl_showcase" src="/3dreconstruction/image/focal_length_showcase.jpg" title="Focal length showcase" />
                                </div>
                                <div>The longer the focal length, the narrower the angle of view and the higher the magnification.
                                </div>
                            </div>
                            <hr />
                            <div>
                                <div><strong>- What is Image center? -</strong></div>
                                <div>The image center, also known as the principal point, is the point in the image where the principal ray (the ray from the scene point through the optical center of the lens) intersects the image plane.</div>
                                <div>
                                    <div>Example:</div>
                                    <img id="cp_showcase" src="/3dreconstruction/image/principle_showcase.png" title="Principle point showcase" />
                                    <div>Image width = 640,  height = 480</div>
                                    <div>cx = 324, cy = 241</div>
                                </div>
                                <div>By default, the cx and cy will be half the image width and height.</div>
                                <div>If you want to adjust the center point of your object in the images, you may configure here.</div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {openImgGuide && (
                <div className='guide-wrapper' onClick={() => setOpenImgGuide(false)}>
                    <div className='guide-container' onClick={(e) => e.stopPropagation()}>
                        <div className='guide-header'>
                            <span>Uploading Guideline</span>
                            <div
                                className='guide-close pointer'
                                onClick={() => setOpenImgGuide(false)}
                            >
                                &#10060;
                            </div>
                        </div>
                        <div className='guide-content'>
                            <div>1. Upload at least 8 images of your object from various views.</div>
                            <div>
                                <div>Example views:</div>
                                <div>                                    
                                    <img src="/3dreconstruction/sample/switch/rgb/b1.png" title="front"/>
                                    <img src="/3dreconstruction/sample/switch/rgb/b3.png" title="front sideways"/>
                                    <img src="/3dreconstruction/sample/switch/rgb/b5.png" title="left"/>
                                    <img src="/3dreconstruction/sample/switch/rgb/b6.png" title="left sideways"/>
                                    <img src="/3dreconstruction/sample/switch/rgb/b9.png" title="back"/>
                                    <img src="/3dreconstruction/sample/switch/rgb/b12.png" title="back sideways"/>
                                    <img src="/3dreconstruction/sample/switch/rgb/b14.png" title="right"/>
                                    <img src="/3dreconstruction/sample/switch/rgb/b15.png" title="right sideways"/>
                                </div>                                
                            </div>
                            <hr />
                            <div>2. Make sure the background of images are clean and well-lit.</div>
                            <hr />
                            <div>3. Avoid using images with watermarks or logos.</div>
                            <hr />
                            <div>4. Use images with a resolution of at most 640x480 pixels.</div>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
};

export default Overview;