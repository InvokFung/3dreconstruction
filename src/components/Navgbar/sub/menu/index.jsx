import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import 'bootstrap/dist/css/bootstrap.min.css';
import useSocket from 'utils/SocketProvider';

function Menu() {
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

    const viewProjectList = () => {
        navigateTo('/projects');
    };

    return (
        <div className="menu-container">
            <nav className="home-links">
                <span className="menuItem bodySmall" onClick={() => navigateTo("/")}>Home</span>
                {(authChecked && authenticated) ? (
                    <>
                        <div className='menuItem bodySmall' onClick={viewProjectList}>
                            Projects
                        </div>
                    </>
                ) : (<></>)}
                <span className="menuItem bodySmall" onClick={() => navigateTo("/samples")}>Samples</span>
                <span className="menuItem bodySmall">FAQ</span>
                <span className="menuItem bodySmall">Contact</span>
            </nav>
        </div>
    );
}

export default Menu;