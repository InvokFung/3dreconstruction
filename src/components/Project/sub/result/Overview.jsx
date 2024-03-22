import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';

import { S3Client, GetObjectCommand, ListObjectsCommand } from "@aws-sdk/client-s3";
import "../css/ProjectResult.css"


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
            retrieveImages();
        }
    }, [authChecked, authenticated]);

    const depthMinVal = useRef();
    const depthMaxVal = useRef();
    const fxVal = useRef();
    const fyVal = useRef();
    const cxVal = useRef();
    const cyVal = useRef();
    const [images, setImages] = useState([]);
    const [imgEdit, setImgEdit] = useState(false);
    const [configEdit, setConfigEdit] = useState(false);
    const projectConfig = projectData.projectConfig;

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
            const blob = new Blob([bodyAsString.buffer], { type: 'image/jpeg' }); // Adjust the MIME type as needed
            const url = URL.createObjectURL(blob);
            return url;
        }));

        return images;
    }

    const retrieveImages = async () => {
        console.log("Fetching images...")

        try {
            let images = await s3Downloadv3();
            setImages(images);
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
        event.currentTarget.disabled = true;

        if (action === "restart") {
            let warningText = `Please ensure the source images and configuration are updated.\nOtherwise the result will be the similar.`;

            if (confirm(warningText) != true) {
                event.currentTarget.disabled = false;
                return;
            }
        }

        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        const userId = userData.userId;
        const projectId = projectData.projectId;
        const formData = new FormData();
        formData.append('userId', userId);
        formData.append('projectId', projectId);
        formData.append('action', action);

        if (action === "image") {
            // Process image update here tmr
        }

        try {
            const projectUrl = `http://localhost:3000/projectUpdate`;
            const response = await fetch(projectUrl, {
                method: 'POST',
                body: formData,
                signal: controllerRef.current.signal
            });
            const data = await response.json();
            console.log(data)
            if (data.status === 200) {
                if (action === "restart") {
                    navigateTo('/projects');
                } else if (action === "image") {
                    console.log("Images updated")
                    setImgEdit(false);
                } else if (action === "config") {
                    console.log("Configuration updated")
                    setConfigEdit(false);
                }
            } else {
                console.log("Error: Restart failed")
            }
        } catch (error) {
            console.log(error);
            event.currentTarget.disabled = false;
        }
    }

    const handleRemoveImage = (index) => {
        setImages(prevImages => prevImages.filter((image, i) => i !== index));
    }

    const cancelEditConfig = () => {
        setConfigEdit(false);
        // retrieveConfig();
    }

    const cancelEditImg = () => {
        setImgEdit(false);
        retrieveImages();
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
                        <div className='section-title'>Configuration</div>
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
                        <div className='rp-content'>
                            <div className='rp-item'>
                                <div>Object Depth</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>min</label>
                                        <input className='halfInput' type='number' step="0.01" ref={depthMinVal} defaultValue={projectConfig.depthMin} disabled={!configEdit} />
                                    </div>
                                    <div className='halfText'>
                                        <label>max</label>
                                        <input className='halfInput' type='number' step="0.01" ref={depthMaxVal} defaultValue={projectConfig.depthMax} disabled={!configEdit} />
                                    </div>
                                </div>
                            </div>
                            <div className='rp-item'>
                                <div>Camera focal length</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>fx</label>
                                        <input className='halfInput' type='number' step="0.01" ref={fxVal} defaultValue={projectConfig.fx} disabled={!configEdit} />
                                    </div>
                                    <div className='halfText'>
                                        <label>fy</label>
                                        <input className='halfInput' type='number' step="0.01" ref={fyVal} defaultValue={projectConfig.fy} disabled={!configEdit} />
                                    </div>
                                </div>
                            </div>
                            <div className='rp-item'>
                                <div>Image center position</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>cx</label>
                                        <input className='halfInput' type='number' step="0.01" ref={cxVal} defaultValue={projectConfig.cx} disabled={!configEdit} />
                                    </div>
                                    <div className='halfText'>
                                        <label>cy</label>
                                        <input className='halfInput' type='number' step="0.01" ref={cyVal} defaultValue={projectConfig.cy} disabled={!configEdit} />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className='overview-image overview-section'>
                    <div className="section-header">
                        <div className='section-title'>Source Images</div>
                        {!imgEdit ? (
                            <div className='section-btn' onClick={() => setImgEdit(true)}>Edit</div>
                        ) : (
                            <div>
                                <div className='section-btn' onClick={cancelEditImg}>Cancel</div>
                                <div className='section-btn' onClick={(event) => updateProject(event, "image")}>Save</div>
                            </div>
                        )}
                    </div>
                    <div className="image-container">
                        {images.map((image, index) => (
                            <div className="image-box" key={index} style={{ position: 'relative' }}>
                                <img
                                    src={image}
                                    alt={`Image ${index}`}
                                    className='uploaded-image'
                                />
                                {imgEdit && (
                                    <div
                                        onClick={() => handleRemoveImage(index)}
                                        className='remove-image-btn'
                                        title="Remove image"
                                    >
                                        X
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            </div >
        </>
    )
};

export default Overview;