import React, { useEffect, useState, useRef } from 'react';
import 'bootstrap/dist/css/bootstrap.min.css';
import { useNavigate } from 'react-router-dom';
import Navbar from 'components/Navgbar';
import useSocket from 'utils/SocketProvider';

const Login = () => {
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

    const handleLogin = async (event) => {
        event.preventDefault();

        // Abort previous request
        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        try {
            // Request to backend for login
            const backendURL = import.meta.env.VITE_BACKEND_URL;
            const response = await fetch(`${backendURL}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password }),
                signal: controllerRef.current.signal
            })
            const data = await response.json();
            if (data.status === 200) {
                console.log(`Login as ${username} successfully.`)
                updateUserData(data);
            } else {
                alert('Invalid username or password');
            }
        } catch (error) {
            console.log(error);
        };
    }

    const handleLogout = () => {
        // Remove token from localStorage
        updateUserData(null);
    };

    return (
        <>
            <Navbar></Navbar>
            <div className="authPage-container">
                <div className='login-form'>
                    {authenticated ? (
                        <div>
                            < h2>Welcome, {username}!</h2>
                            <button className="btn btn-primary" onClick={handleLogout}>Logout</button>
                        </div>
                    ) : (
                        <>
                            <form onSubmit={handleLogin}>
                                <h2>Login</h2>
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
                                <button type="submit" id="submit-btn" className="btn">Login</button>
                            </form>
                            <button className="btn redirect" onClick={() => navigateTo('/register')}>Not registered yet? Sign-up now</button>
                        </>
                    )}
                </div>
            </div>
        </>
    )
}

export default Login;