import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './css/Navbar.css'
import Authentication from './sub/account';
import Menu from './sub/menu';
import "./css/home.css";
import "./css/style.css";

const Navbar = () => {
    const navigateTo = useNavigate();

    const toHome = () => {
        navigateTo('/');
    }

    return (
        <div className="navbar-container">
            <span className="logo logo-white" onClick={toHome}>WEBRECON</span>            
            <Menu></Menu>
            <Authentication></Authentication>
        </div>
    );
}

export default Navbar;