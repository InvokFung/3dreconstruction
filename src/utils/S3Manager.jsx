import React, { createContext, useContext, useState, useEffect, useRef } from 'react';

export const SocketContext = createContext();

export const SocketProvider = ({ children }) => {
    const [authenticated, setAuthenticated] = useState(false);
    const [userData, setUserData] = useState({});
    const [authChecked, setAuthChecked] = useState(false);
    const controllerRef = useRef(null);
    const verifyControllerRef = useRef(null);

    return (
        <SocketContext.Provider value={{
            authenticated,
            setAuthenticated,
            userData,
            setUserData,
            authChecked,
            setAuthChecked,
            controllerRef,
            verifyControllerRef
        }}>
            {children}
        </SocketContext.Provider>
    )
}

export default function useSocket() {
    const {
        authenticated,
        setAuthenticated,
        userData,
        setUserData,
        authChecked,
        setAuthChecked,
        controllerRef,
        verifyControllerRef
    } = useContext(SocketContext);

    const handleAuthState = async () => {
        const authToken = localStorage.getItem('authToken');
        const username = localStorage.getItem('username');
        if (authToken) {
            console.log("Found auth token:", authToken)

            verifyControllerRef.current = new AbortController();

            const verifyUrl = `http://localhost:3000/verify/${username}/${authToken}`
            const reponse = await fetch(verifyUrl, {
                method: 'GET',
                signal: verifyControllerRef.current.signal
            });
            const data = await reponse.json();
            if (data.status === 200) {
                console.log("User is logged in as:", username)
                const userData = {
                    username,
                    authToken
                }
                updateUserData(userData);
            } else {
                // Remove token from localStorage
                console.log("Invalid auth token found")
                updateUserData(null);
            }
        } else {
            console.log("No auth token found")
        }
    }

    const updateUserData = (userData) => {
        if (userData) {
            setUserData(userData);
            // Save login state to localStorage
            localStorage.setItem('authToken', userData.authToken)
            localStorage.setItem('username', userData.username);
            setAuthenticated(true);
        } else {
            setUserData({});
            // Clear login state from localStorage
            localStorage.removeItem('authToken');
            localStorage.removeItem('username');
            setAuthenticated(false);
        }
    }

    const authCheck = async () => {
        if (!authChecked && !verifyControllerRef.current) {
            await handleAuthState();
            setAuthChecked(true);
        }
    }
    useEffect(() => {
        authCheck();
        return () => {
            if (verifyControllerRef.current)
                verifyControllerRef.current.abort();
        }
    }, []);

    return {
        authenticated,
        setAuthenticated,
        userData,
        setUserData,
        updateUserData,
        authChecked,
        setAuthChecked,
        controllerRef
    };
}