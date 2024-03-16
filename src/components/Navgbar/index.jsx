import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './css/Navbar.css'
import Authentication from './sub/account';
import Menu from './sub/menu';

const Navbar = () => {
    const navigateTo = useNavigate();

    const toHome = () => {
        navigateTo('/');
    }

    return (
        <div className="navbar">
            <div className='site-name' onClick={toHome}>
                3D Reconstruction
            </div>
            <Menu></Menu>
            <Authentication></Authentication>
        </div>
    );
}

export default Navbar;