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
    const [projectChecked, setProjectChecked] = useState(false);
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
            const backendURL = import.meta.env.VITE_BACKEND_URL;
            const projectUrl = `${backendURL}/getProjects/${userId}`;
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
                setProjectChecked(true);
            } else {
                alert('Failed to load projects');
            }
        } catch (error) {
            console.log(error);
        }
    }

    const createProject = async () => {
        if (projectName.trim() === '') {
            alert('Project name cannot be empty');
            return;
        }

        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        try {
            const projectData = {
                projectName: projectName,
                projectOwner: userData.userId
            }
            const backendURL = import.meta.env.VITE_BACKEND_URL;
            const projectUrl = `${backendURL}/createProject/`;
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

    const [showModal, setShowModal] = useState(false);
    const [projectName, setProjectName] = useState('New Project');

    const openModal = () => {
        setShowModal(true);
    };

    const closeModal = () => {
        setShowModal(false);
    };

    const handleInputChange = (event) => {
        setProjectName(event.target.value);
    };

    return (
        <>
            <Navbar></Navbar>
            <div id="project-list" className="project-field">
                <div className='project-list-header'>
                    <div className='project-list-title'>Your Projects</div>
                    <div className="redirect btn" onClick={openModal}>Create Project</div>
                </div>
                {
                    projectChecked && (
                        projectList.length == 0 ? (
                            <div className='project-list-empty'>
                                <div>It looks like you haven't started any projects yet.</div>
                                <div>Why not create one and bring your ideas to life?</div>
                            </div>
                        ) : (
                            <div className='table-wrapper'>
                                <table className="styled-table">
                                    <thead>
                                        <tr>
                                            <th>Project Id</th>
                                            <th>Project Name</th>
                                            <th>Create Date</th>
                                            <th>Status</th>
                                            <th></th>
                                        </tr >
                                    </thead >
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
                                </table >
                            </div >
                        )
                    )
                }
            </div >
            {showModal && (
                <div className="project-modal">
                    <div className="modal-content">
                        <div className="modal-header">
                            <div className='modal-title'>Project Setup</div>
                            <span className="modal-close-button" onClick={closeModal}>&times;</span>
                        </div>
                        <form onSubmit={createProject}>
                            <div>Project Name</div>
                            <input className="modal-input" type="text" value={projectName} onChange={handleInputChange} />
                            <input id="launch-btn" className="btn" type="submit" value="Launch Project" />
                        </form>
                    </div>
                </div>
            )}
        </>
    )
};

export default ProjectList;