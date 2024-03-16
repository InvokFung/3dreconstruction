import React, { useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import './main.css';

import Scene from "app/scene"

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

import Navbar from '../navbar';
import Reconstruction from './Reconstruction';
import AuthPage from '../Auth';

const Main = () => {
    const baseName = "/3dreconstruction"
    const [page, setPage] = useState('home');

    useEffect(() => {
        const pageName = location.pathname.replace(baseName, '');
        // if (pageName.includes("task")) {
        //     setPage('task');
        // } else if (pageName.includes("auth")) {
        //     setPage('auth');
        // } else if (pageName == "/") {
        //     setPage('home');
        // }else {
        //     setPage('404');
        // }
    }, [location]);

    return (
        <>
            <Navbar></Navbar>
            {page == "home" ? (
                <div>home</div>
            ) : page == "auth" ? (
                <AuthPage></AuthPage>
            ) : page == "task" ? (
                <Reconstruction></Reconstruction>
            ) : (
                <div>404 Page Not Found</div>
            )}
        </>
    )
};

export default Main;