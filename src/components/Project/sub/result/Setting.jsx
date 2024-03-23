import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';

const Setting = ({ projectData }) => {
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

    const navigateTo = useNavigate();

    const projectNameRef = useRef();

    const updateProject = async (action) => {
        if (action === "delete") {
            if (!window.confirm("Please confirm to delete this project.")) {
                return;
            }
        } else if (action === "rename") {
            if (projectNameRef.current.value.trim() === '') {
                alert('Project name cannot be empty');
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

        if (action === "rename") {
            const projectName = projectNameRef.current.value;
            if (projectName.length === 0) {
                alert("Project name cannot be empty");
                return;
            }
            formData.append('projectName', projectName);
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
                window.location.reload();
            } else {
                alert('Failed to update project');
            }
        } catch (error) {
            console.log(error);
        }
    }


    // =============================================================

    return (
        <>
            <div className="project background-field">
                <div className='setting-tab'>
                    <div className="setting-header">General</div>
                    <div className="setting-section">
                        <div className="section-title">Project Name</div>
                        <input className="section-input" type="text" defaultValue={projectData.projectName} ref={projectNameRef} />
                        <div className='section-btn' onClick={() => updateProject("rename")}>Rename</div>
                    </div>
                    <div className="setting-section">
                        <div className="section-title">Danger Zone</div>
                        <div className="danger-wrapper">
                            <div className='danger-field'>
                                <div className="danger-content">
                                    <span className="danger-title">Delete this project</span>
                                    <span className="danger-desc">Once you delete a project, there is no going back.</span>
                                </div>
                                <div className='section-btn danger-btn' onClick={() => updateProject("delete")}>Delete this project</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </>
    )
};

export default Setting;