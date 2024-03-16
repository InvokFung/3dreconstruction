import React, { useEffect, useState, useRef } from 'react';
import './css/Home.css';
import { useNavigate } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';
import Navbar from 'components/Navbar';

const Main = () => {
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

    const getStarted = () => {
        if (!authenticated)
            navigateTo('/login');
        else {
            navigateTo('/projects');
        }
    }

    return (
        <>
            <Navbar></Navbar>
            <div className='home-container'>
                <h2>Online Image to 3D Conversion Tool</h2>
                <img src="https://via.placeholder.com/150" alt="placeholder" />
                <h3>Upload your images and we'll convert them to a 3D model for you!</h3>
                <div className="btn btn-primary" onClick={getStarted}>Get Started</div>
            </div>
        </>
    )
};

export default Main;