import React, { useEffect, useState, useRef } from 'react';
import './css/Project.css';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';
import Navbar from 'components/Navgbar';

import ProjectUpload from './sub/ProjectUpload';
import ProjectConfig from './sub/ProjectConfig';
import ProjectProgress from './sub/ProjectProgress';
import ProjectResult from './sub/ProjectResult';

const Reconstruction = () => {
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

    const initProjectPage = async () => {
        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        const userId = userData.userId;
        const detailName = "status";

        try {
            const projectUrl = `http://localhost:3000/getProjectDetails/${userId}/${projectId}?detail=${detailName}`;
            const response = await fetch(projectUrl, {
                method: 'GET',
                signal: controllerRef.current.signal
            });
            const data = await response.json();
            console.log(data)
            if (data.status === 200) {
                const projectStatus = data.projectStatus;
                switch (projectStatus) {
                    case "idle":
                        setStage(1);
                        break;
                    case "config":
                        setStage(2);
                        break;
                    case "processing":
                        setStage(3);
                        break;
                    case "completed":
                    case "error":
                        setStage(4);
                        break;
                }
            } else {
                alert('Failed to locate projects');
            }
        } catch (error) {
            console.log(error);
        }
    }

    useEffect(() => {
        if (authChecked && !authenticated) {
            navigateTo('/login');
        } else if (authChecked && authenticated) {
            console.log("Starting app...")
            console.log(import.meta.env.VITE_AWS_ACCESS_KEY_ID)

            initProjectPage();
        }
    }, [authChecked, authenticated]);

    const [stage, setStage] = useState(0);
    const [page, setPage] = useState("Result");

    const childProps = {
        stage,
        setStage,
        page,
        setPage
    }

    // =============================================================

    return (
        <>
            <Navbar></Navbar>
            <div className="project">
                {stage == 1 && (<ProjectUpload props={childProps}></ProjectUpload>)}
                {stage == 2 && (<ProjectConfig props={childProps}></ProjectConfig>)}
                {stage == 3 && (<ProjectProgress props={childProps}></ProjectProgress>)}
                {stage == 4 && (
                    <>
                        {page == "Result" && (<ProjectResult props={childProps}></ProjectResult>)}
                        {page == "Setting" && (<ProjectSetting props={childProps}></ProjectSetting>)}
                    </>
                )}
            </div>
        </>
    )
};

export default Reconstruction;