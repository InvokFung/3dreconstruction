import React, { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import './css/AuthPage.css'
import { useNavigate } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';
import Navbar from 'components/Navgbar';

const Profile = () => {
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

    const username = userData.username;

    useEffect(() => {
        if (authChecked && !authenticated) {
            navigateTo('/login');
        }
    }, [authChecked, authenticated]);

    const viewProjectList = () => {
        navigateTo('/projects');
    }

    return (
        <>
            <Navbar></Navbar>
            <div className='profile-container'>
                <div className='profile'>
                    < h2>Welcome, {username}!</h2>
                    <button className="btn btn-primary" onClick={viewProjectList}>View your projects</button>
                </div>
            </div>
        </>
    )
}

export default Profile;