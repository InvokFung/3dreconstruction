import React, { useEffect, useState, useRef } from 'react';
import './css/ProjectList.css';
import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';
import Navbar from 'components/Navgbar';

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

    const { projectId } = useParams();
    const [projectList, setProjectList] = useState([]);
    const navigateTo = useNavigate();

    useEffect(() => {
        if (authChecked && !authenticated) {
            navigateTo('/login');
        } else if (authChecked && authenticated) {
            loadProjects();
        }
    }, [authChecked, authenticated]);

    const loadProjects = async () => {
        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();
        
        const userId = userData.userId;

        try {
            const projectUrl = `http://localhost:3000/getProjects/${userId}`;
            const response = await fetch(projectUrl, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
                signal: controllerRef.current.signal
            });
            const data = await response.json();
            console.log(data)
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
        console.log(userData)

        try {
            const projectData = {
                projectName: 'New Project',
                projectOwner: userData.userId
            }
            const projectUrl = `http://localhost:3000/createProject/`;
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

    function formatDate(dateString) {
        const date = new Date(dateString);
        return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    }

    const viewProject = (projectId) => {
        navigateTo(`/project/${projectId}`);
    }

    return (
        <>
            <Navbar></Navbar>
            <div id="project-list" className="project-field">
                <h3>Your Projects</h3>
                <table className="styled-table">
                    <thead>
                        <tr>
                            <th>Project Id</th>
                            <th>Project Name</th>
                            <th>Create Date</th>
                            <th>Status</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {projectList.map((project, index) => (
                            <tr key={index}>
                                <td>{project.projectId}</td>
                                <td>{project.projectName}</td>
                                <td>{formatDate(project.projectDate)}</td>
                                <td>{project.projectStatus.charAt(0).toUpperCase() + project.projectStatus.slice(1)}</td>
                                <td><button className='redirect' onClick={() => viewProject(project.projectId)}>Browse</button></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <button className="redirect" onClick={createProject}>Create Project</button>
            </div>
        </>
    )
};

export default ProjectList;