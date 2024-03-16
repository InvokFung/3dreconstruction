import React, { useState } from 'react';
import './navbar.css'
import Authentication from './sub/account';

function Navbar() {


    return (
        <div className="navbar">
            <a className='site-name' href="/">
                3D Reconstruction
            </a>
            <Authentication></Authentication>
        </div>
    );
}

export default Navbar;