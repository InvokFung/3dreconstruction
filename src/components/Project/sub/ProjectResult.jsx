import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';
import Navbar from 'components/Navgbar';

import Scene from "app/scene"

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import Overview from "./result/Overview";
import Result from "./result/Result";
import Setting from "./result/Setting";
import "../css/Project.css";
import "./css/ProjectResult.css";


const ProjectResult = () => {

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

    const { projectId, tab } = useParams();
    const navigateTo = useNavigate();

    const [activeTab, setActiveTab] = useState(tab || 'overview');
    const [projectData, setProjectData] = useState({})

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
                navigateTo('/projects');
            }
        } catch (error) {
            console.log(error);
        }
    }


    useEffect(() => {
        console.log(authChecked, authenticated)
        if (authChecked && !authenticated) {
            navigateTo('/login');
        } else if (authChecked && authenticated) {
            getProjectDetails();
        }
    }, [authChecked, authenticated]);

    useEffect(() => {
        navigateTo(`/project/${projectId}/${activeTab}`, { replace: true });
    }, [activeTab, navigateTo, projectId]);

    const gotoProjects = () => {
        navigateTo('/projects');
    }

    useEffect(() => {
        return () => {
            if (controllerRef.current)
                controllerRef.current.abort();
        }
    }, [])

    // =============================================================

    return (
        <>
            <Navbar></Navbar>
            <div className="project">
                <div className='project-header-clean'>
                    <span className="project-breadcrumb" onClick={gotoProjects}>{userData.username}</span>
                    <span className='breadcrumb-symbol'>&nbsp;/&nbsp;</span>
                    <span className="project-breadcrumb" onClick={() => setActiveTab('overview')}>New Project</span>
                </div>
                <div className="project-tab">
                    <div className={`tab-btn ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>Overview</div>
                    <div className={`tab-btn ${activeTab === 'result' ? 'active' : ''}`} onClick={() => setActiveTab('result')}>Result</div>
                    <div className={`tab-btn ${activeTab === 'setting' ? 'active' : ''}`} onClick={() => setActiveTab('setting')}>Setting</div>
                </div>
                {Object.keys(projectData).length > 0 && (
                    <>
                        {activeTab === 'overview' && <Overview projectData={projectData}></Overview>}
                        {activeTab === 'result' && <Result projectData={projectData}></Result>}
                        {activeTab === 'setting' && <Setting projectData={projectData}></Setting>}
                    </>
                )}
            </div>
        </>
    )
};

export default ProjectResult;