import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';
import Navbar from 'components/Navgbar';

import Scene from "app/scene"

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";


const ProjectProgress = () => {
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
        if (authChecked && !authenticated) {
            navigateTo('/login');
        } else if (authChecked && authenticated) {
            getProjectProgress();
        }
    }, [authenticated]);

    const getProjectProgress = async () => {
        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        const userId = userData.userId;
        const detailName = "progress";

        try {
            const projectUrl = `http://localhost:3000/getProjectDetails/${userId}/${projectId}?detail=${detailName}`;
            const response = await fetch(projectUrl, {
                method: 'GET',
                signal: controllerRef.current.signal
            });
            const data = await response.json();            
            if (data.status === 200) {
                const progress = data.progress;
                setProgress(progress);
            } else {
                alert('Failed to load projects');
            }
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
            </div>
        </>
    )
};

export default ProjectProgress;