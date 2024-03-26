import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';

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

    const [hasError, setError] = useState(false);

    const [progress, setProgress] = useState(0);

    useEffect(() => {
        if (authChecked && authenticated) {
            getProjectProgress();
        }
    }, [authChecked, authenticated]);

    const bindProgressListener = async (userId) => {
        const backendURL = import.meta.env.VITE_BACKEND_URL;
        const source = new EventSource(`${backendURL}/process_image/${userId}/${projectId}`);

        source.onerror = function (error) {
            console.log('EventSource connection error');
            console.error(error)
            if (!hasError)
                setError(true);
        };

        let localProgress = 0;

        await new Promise((resolve, reject) => {
            source.onmessage = function (event) {
                if (event.data === 'READY') {
                    resolve(source);
                    setError(false);
                } else if (event.data === 'CLOSE') {
                    source.close();
                    if (localProgress != 100) {
                        console.log("Error: Process failed")
                    }
                    setStage(4);
                } else {
                    // console.log(`Progress: ${event.data}%`);
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

        const listener = await bindProgressListener(userId);
    }

    // =============================================================

    return (
        <>
            <div className="project-progress">
                <div className='project-header'>Project {projectId} - New Project</div>
                <div className='progressbar-header'>{hasError ? "An error has occured during reconstruction, please refresh." : "Processing the reconstruction ..."}</div>
                <div id="project-progressbar-wrapper" className={`progress ${hasError ? "error" : ""}`}>
                    <div id="project-progressbar" className="progress-bar progress-bar-striped active animate" role="progressbar" aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100" style={{ width: `${progress}%` }}>
                        {progress}%
                    </div>
                </div>
                <div className="progress-reminder">
                    <span>Please note that the processing time may vary depending on the quality and quantity of the images.</span>
                    <span>The processing time typically ranges from a few minutes to a few hours. Your patience is appreciated.</span>
                </div>
            </div>
        </>
    )
};

export default ProjectProgress;