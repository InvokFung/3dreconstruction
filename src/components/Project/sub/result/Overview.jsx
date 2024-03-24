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

    const projectController = useRef();
    const configController = useRef();

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
                            {updateConfigStatus && <Reminder status={updateConfigStatus} key={updateConfigStatus} />}
                        </div>
                        {!configEdit ? (
                            <div className='section-btn' onClick={() => setConfigEdit(true)}>Edit</div>
                        ) : (
                            <div>
                                <div className='section-btn' onClick={cancelEditConfig}>Cancel</div>
                                <div className='section-btn' onClick={(event) => updateProject(event, "config")}>Save</div>
                            </div>
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
                        </div>
                    </div>
                </div>
                <div className='overview-image overview-section'>
                    <div className="section-header">
                        <div className='section-title'>
                            <span>Source Images</span>
                            {updateImageStatus && <Reminder status={updateImageStatus} key={updateImageStatus} />}
                        </div>
                        {!imgEdit ? (
                            <div className='section-btn' onClick={() => setImgEdit(true)}>Edit</div>
                        ) : (
                            <div>
                                <div className='section-btn' onClick={cancelEditImg}>Cancel</div>
                                <div className='section-btn' onClick={(event) => updateProject(event, "image")}>Save</div>
                            </div>
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
        </>
    )
};

export default Overview;