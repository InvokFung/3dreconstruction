import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import 'bootstrap/dist/css/bootstrap.min.css';
import useSocket from 'utils/SocketProvider';

function MobileMenu() {
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

    const mobileMenuRef = useRef();
    const [isOpen, setIsOpen] = useState(false);
    const navigateTo = useNavigate();

    useEffect(() => {
        if (isOpen) {
            mobileMenuRef.current.classList.add("active")
        } else {
            mobileMenuRef.current.classList.remove("active")
        }
    }, [isOpen]);

    const handleMenuClick = () => {
        setIsOpen(!isOpen);
    };

    const viewProjectList = () => {
        navigateTo('/projects');
        setIsOpen(false);
    };

    const handleNavigation = (path) => {
        navigateTo(path);
        setIsOpen(false);
    };

    const viewProfile = () => {
        navigateTo('/profile');
    };

    const handleLogout = () => {
        updateUserData(null);
    };

    return (
        <>
            <button onClick={handleMenuClick} className="mobile-menu-icon">
                {isOpen ? 'X' : '\u2630'}
            </button>
            <div ref={mobileMenuRef} className="menu-container-mobile">
                {isOpen && (
                    <nav className="home-links-mobile">
                        <span className="menuItem bodySmall" onClick={() => handleNavigation("/")}>Home</span>
                        {(authChecked && authenticated) ? (
                            <>
                                <span className='menuItem bodySmall' onClick={viewProjectList}>
                                    Projects
                                </span>
                            </>
                        ) : (<></>)}
                        <span className="menuItem bodySmall" onClick={() => handleNavigation("/samples")}>Samples</span>
                        <span className="menuItem bodySmall">FAQ</span>
                        <span className="menuItem bodySmall">Contact</span>
                        {authenticated ? (
                            <>
                                <div className='mobile-menu-span'>
                                    <span className="buttonFlat btn" onClick={() => handleNavigation("/profile")}>Profile</span>
                                </div>
                                <div className='mobile-menu-span'>
                                    <span className="buttonFilled btn" onClick={handleLogout}>Logout</span>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className='mobile-menu-span'>
                                    <span className="btn home-login buttonFlat" onClick={() => handleNavigation("/login")}>Login</span>
                                </div>
                                <div className='mobile-menu-span'>
                                    <span className="btn buttonFilled" onClick={() => handleNavigation("/register")}>Register</span>
                                </div>
                            </>
                        )}
                    </nav>
                )}
            </div>
        </>
    );
}

export default MobileMenu;