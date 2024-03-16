import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import 'bootstrap/dist/css/bootstrap.min.css';
import Navbar from 'components/Navbar';
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
    }, [authenticated]);

    const handleRegister = async (event) => {
        event.preventDefault();

        // Abort previous request
        if (controllerRef.current)
            controllerRef.current.abort();

        controllerRef.current = new AbortController();

        try {
            // Request to backend for login
            const response = await fetch('http://localhost:3000/register', {
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
                const userData = {
                    username: username,
                    authToken: data.authToken
                }
                updateUserData(userData);
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
                {authenticated ? (
                    <div>
                        < h2>Welcome, {username}!</h2>
                        <button className="btn btn-primary">Logout</button>
                    </div>
                ) : (
                    <>
                        <form onSubmit={handleRegister}>
                            <h2>Sign-up</h2>
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
                            <button type="submit" id="submit-btn" className="btn btn-primary">Register</button>
                        </form>
                        <button onClick={() => navigateTo('/login')}>Already have an account? Login now</button>
                    </>
                )}
            </div>
        </>
    )
}

export default Register;