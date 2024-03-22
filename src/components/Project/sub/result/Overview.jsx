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
        console.log("Fetching result...")

        try {
            let images = await s3Downloadv3();
            setImages(images);
            console.log("Result fetched.")
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

    const restartProject = async () => {
        let warningText = `Please ensure the source images and configuration are updated.\nOtherwise the result will be the similar.`;

        if (confirm(warningText) != true) {
            return;
        }

        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        const action = "restart";
        const userId = userData.userId;
        const projectId = projectData.projectId;
        const formData = new FormData();
        formData.append('userId', userId);
        formData.append('projectId', projectId);
        formData.append('action', action);

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
                navigateTo('/projects');
            } else {
                console.log("Error: Restart failed")
            }
        } catch (error) {
            console.log(error);
        }
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
                                <td><div className='btn' onClick={restartProject}>Restart</div></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div className='overview-config overview-section'>
                    <div className='section-title'>Configuration</div>
                    <div className='rcs-parameter'>
                        <div className='rp-content'>
                            <div className='rp-item'>
                                <div>Object Depth</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>min</label>
                                        <input className='halfInput' type='number' step="0.01" ref={depthMinVal} defaultValue={projectConfig.depthMin} />
                                    </div>
                                    <div className='halfText'>
                                        <label>max</label>
                                        <input className='halfInput' type='number' step="0.01" ref={depthMaxVal} defaultValue={projectConfig.depthMax} />
                                    </div>
                                </div>
                            </div>
                            <div className='rp-item'>
                                <div>Camera focal length</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>fx</label>
                                        <input className='halfInput' type='number' step="0.01" ref={fxVal} defaultValue={projectConfig.fx} />
                                    </div>
                                    <div className='halfText'>
                                        <label>fy</label>
                                        <input className='halfInput' type='number' step="0.01" ref={fyVal} defaultValue={projectConfig.fy} />
                                    </div>
                                </div>
                            </div>
                            <div className='rp-item'>
                                <div>Image center position</div>
                                <div className='multiInput'>
                                    <div className='halfText'>
                                        <label>cx</label>
                                        <input className='halfInput' type='number' step="0.01" ref={cxVal} defaultValue={projectConfig.cx} />
                                    </div>
                                    <div className='halfText'>
                                        <label>cy</label>
                                        <input className='halfInput' type='number' step="0.01" ref={cyVal} defaultValue={projectConfig.cy} />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div className='overview-image overview-section'>
                    <div className='section-title'>Source Images</div>
                    <div className="image-container">
                        {images.map((image, index) => (
                            <div className="image-box" key={index} style={{ position: 'relative' }}>
                                <img
                                    src={image}
                                    alt={`Image ${index}`}
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
            </div >
        </>
    )
};

export default Overview;