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
            {(authChecked && authenticated) ? (
                <>
                    <div className='menuItem' onClick={viewProjectList}>
                        projectList
                    </div>
                </>
            ) : (<></>)}
        </div>
    );
}

export default Menu;