import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';
import Navbar from 'components/Navgbar';

import Scene from "app/scene"

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";


const ProjectProgress = ({ props }) => {
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

    const [progress, setProgress] = useState(0);

    useEffect(() => {
        if (authChecked && authenticated) {
            getProjectProgress();
        }
    }, [authChecked, authenticated]);

    const bindProgressListener = async (userId) => {
        const source = new EventSource(`http://localhost:3000/process_image/${userId}/${projectId}`);

        source.onerror = function (error) {
            console.log('EventSource connection error');
            console.error(error)
        };

        let localProgress = 0;

        await new Promise((resolve, reject) => {
            source.onmessage = function (event) {
                if (event.data === 'READY') {
                    resolve(source);
                } else if (event.data === 'CLOSE') {
                    source.close();
                    if (localProgress != 100) {
                        console.log("Error: Process failed")
                    }
                    setStage(4);
                } else {
                    console.log(`Progress: ${event.data}%`);
                    setProgress(event.data);
                    localProgress = event.data;
                }
            };
        })
        return source;
    }

    const getProjectProgress = async () => {
        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        const userId = userData.userId;
        const detailName = "progress";

        try {
            const listener = await bindProgressListener(userId);
            // const projectUrl = `http://localhost:3000/getProjectDetails/${userId}/${projectId}?detail=${detailName}`;
            // const response = await fetch(projectUrl, {
            //     method: 'GET',
            //     signal: controllerRef.current.signal
            // });
            // const data = await response.json();
            // if (data.status === 200) {
            //     const progress = data.progress;
            //     setProgress(progress);
            // } else {
            //     alert('Failed to load projects');
            // }
        } catch (error) {
            console.log(error);
        }
    }

    // =============================================================

    return (
        <>
            <div className="project">
                <div className='project-header'>Project {projectId} - New Project</div>
                <div>Processing...</div>
                <div>Progress bar: {progress}%</div>
                <div className="reminder">
                    <p>Please note that the processing time may vary depending on the quality and quantity of the images.</p>
                    <p>It could take around 5 - 30 minutes. Thank you for your patience.</p>
                </div>
            </div>
        </>
    )
};

export default ProjectProgress;