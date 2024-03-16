import React, { useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import './css/ProjectList.css';

import Scene from "app/scene"

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { useNavigate } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';
import Navbar from '../Navbar';

const ProjectList = () => {
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

    const [projectList, setProjectList] = useState([]);
    const navigateTo = useNavigate();

    useEffect(() => {
        if (authChecked && !authenticated) {
            navigateTo('/login');
        } else if (authChecked && authenticated) {
            loadProjects();
        }
    }, [authenticated]);

    const loadProjects = async () => {
        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        try {
            const projectUrl = `http://localhost:3000/projects/${userData.username}`;
            const response = await fetch(projectUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
                signal: controllerRef.current.signal
            });
            const data = await response.json();
            if (data.status === 200) {
                setProjectList(data.projects);
            } else {
                alert('Failed to load projects');
            }
        } catch (error) {
            console.log(error);
        }
    }

    const createProject = async () => {
        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        try {
            const projectData = {
                projectName: 'New Project',
                projectStatus: 'idle',
                projectOwner: userData.username
            }
            const projectUrl = `http://localhost:3000/create_project/`;
            const response = await fetch(projectUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(projectData),
                signal: controllerRef.current.signal
            });
            const data = await response.json();
            if (data.status === 200) {
                navigateTo(0)
            } else {
                alert('Failed to create project');
            }
        } catch (error) {
            console.log(error);
        }
    }

    const viewProject = (projectId) => {
        navigateTo(`/project/${projectId}`);
    }

    return (
        <>
            <Navbar></Navbar>
            <div className="project-list">
                <h3>Project list</h3>
                <table className="styled-table">
                    <thead>
                        <tr>
                            <th>Project Id</th>
                            <th>Project Name</th>
                            <th>Create Date</th>
                            <th>Status</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {projectList.map((project, index) => (
                            <tr key={index}>
                                <td>{project.projectId}</td>
                                <td>{project.projectName}</td>
                                <td>{project.projectDate}</td>
                                <td>{project.projectStatus}</td>
                                <td><button onClick={() => viewProject(project.projectId)}>View</button></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <button onClick={createProject}>Create Project</button>
            </div>
        </>
    )
};

export default ProjectList;