import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import 'bootstrap/dist/css/bootstrap.min.css';
import useSocket from 'utils/SocketProvider';

function Authentication() {
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

    const username = userData.username;
    const navigateTo = useNavigate();

    const viewProfile = () => {
        navigateTo('/profile');
    };

    const handleLogin = (event) => {
        navigateTo('/login');
    };

    const handleLogout = () => {
        updateUserData(null);
    };

    return (
        <div className="auth-container">
            {authenticated ? (
                <>
                    <div className='account' onClick={viewProfile}>
                        <div>{username}</div>
                    </div>
                    <div className="btn btn-primary" onClick={handleLogout}>Logout</div>
                </>
            ) : (
                <div className='btn' onClick={handleLogin}>Login</div>
            )}
        </div>
    );
}

export default Authentication;