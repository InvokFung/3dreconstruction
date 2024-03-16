import React, { useState } from 'react';
import './css/Navbar.css'
import Authentication from './sub/account';
import Menu from './sub/menu';

const Navbar = () => {

    return (
        <div className="navbar">
            <a className='site-name' href="/">
                3D Reconstruction
            </a>
            <Menu></Menu>
            <Authentication></Authentication>
        </div>
    );
}

export default Navbar;