import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import 'bootstrap/dist/css/bootstrap.min.css';
import Navbar from 'components/Navgbar';
import useSocket from 'utils/SocketProvider';

const Register = () => {
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

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');

    const navigateTo = useNavigate();

    useEffect(() => {
        if (authenticated) {
            navigateTo('/profile');
        }
    }, [authChecked, authenticated]);

    const handleRegister = async (event) => {
        event.preventDefault();

        // Abort previous request
        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        try {
            // Request to backend for login
            const backendURL = import.meta.env.VITE_BACKEND_URL;
            const response = await fetch(`${backendURL}/register`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password }),
                signal: controllerRef.current.signal
            })
            const data = await response.json();

            if (data.status === 200) {
                console.log(`Registered as ${username} successfully.`)               
                updateUserData(data);
            } else {
                alert('Username already exist, please try another username');
            }
        } catch (error) {
            console.log(error);
        }
    };

    return (
        <>
            <Navbar></Navbar>
            <div className="authPage-container">
                <div className="register-form">
                    {!authenticated && (
                        <>
                            <form onSubmit={handleRegister}>
                                <div className='auth-header'>Sign-up</div>
                                <div className="form-group">
                                    <label>Username</label>
                                    <input
                                        type="text"
                                        className="form-control"
                                        value={username}
                                        onChange={e => setUsername(e.target.value)}
                                        placeholder='Enter your username here'
                                        required
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Password</label>
                                    <input
                                        type="password"
                                        className="form-control"
                                        value={password}
                                        onChange={e => setPassword(e.target.value)}
                                        placeholder='Enter your password here'
                                        required
                                    />
                                </ div>
                                <button type="submit" id="submit-btn" className="btn">Register</button>
                            </form>
                            <button className="btn redirect" onClick={() => navigateTo('/login')}>Already have an account? Login now</button>
                        </>
                    )}
                </div>
            </div>
        </>
    )
}

export default Register;