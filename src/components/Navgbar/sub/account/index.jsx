import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import 'bootstrap/dist/css/bootstrap.min.css';
import useSocket from 'utils/SocketProvider';
import userIcon from "./user-icon.png";

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

    const handleLogout = () => {
        updateUserData(null);
    };

    return (
        <div className="auth-container">
            {authenticated ? (
                <>
                    <div className='account' onClick={viewProfile} title="View Profile">
                        <img className="user-icon" src={userIcon} />
                        {username}
                    </div>
                    <div className="buttonFilled btn" onClick={handleLogout}>Logout</div>
                </>
            ) : (
                <div className="home-buttons">
                    <div className="btn home-login buttonFlat" onClick={() => navigateTo("/login")}>Login</div>
                    <div className="btn buttonFilled" onClick={() => navigateTo("/register")}>Register</div>
                </div>
            )}
        </div>
    );
}

export default Authentication;