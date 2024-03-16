import React, { useEffect, useState } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import './css/AuthPage.css'
import Login from './sub/Login';
import Register from './sub/Register';
import Profile from './sub/Profile';

const baseName = "/3dreconstruction"

const AuthPage = () => {    
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [username, setUsername] = useState('');
    const [page, setPage] = useState('login');

    const handleAuthState = async () => {
        const authToken = localStorage.getItem('authToken');
        const username = localStorage.getItem('username');
        if (authToken) {
            console.log("Found auth token:", authToken)
            const reponse = await fetch('http://localhost:3000/verify', {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, authToken }),
            })
            const data = await reponse.json();
            if (data.status === 200) {
                console.log("User is logged in as:", data.username)
                setIsLoggedIn(true);
                setUsername(data.username);
            }
        }
    }

    useEffect(() => {
        const pageName = location.pathname.replace(baseName, '');
        if (pageName.includes("register")) {
            setPage('register');
        } else {
            setPage('login');
        }
    }, [location]);

    // Load login state from localStorage when component mounts
    useEffect(() => {
        handleAuthState();
    }, []);

    return (
        <>
            {isLoggedIn ? (
                <Profile></Profile>
            ) : (
                page === 'login' ?
                    <Login props={{
                        isLoggedIn,
                        setIsLoggedIn
                    }}></Login>
                    :
                    <Register props={{
                        isLoggedIn,
                        setIsLoggedIn
                    }}></Register>
            )}
        </>
    )
}

export default AuthPage;