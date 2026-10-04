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
            
            const backendURL = import.meta.env.VITE_BACKEND_URL;
            const verifyUrl = `${backendURL}/verify/${username}/${authToken}`
            const reponse = await fetch(verifyUrl, {
                method: 'GET',
                signal: verifyControllerRef.current.signal
            });
            const data = await reponse.json();
            if (data.status === 200) {
                console.log("User is logged in as:", username)
                updateUserData(data);
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
            const { authToken, userId, username } = userData;
            const savedData = { authToken, userId, username };
            setUserData(savedData);
            // Save login state to localStorage
            localStorage.setItem('authToken', authToken)
            localStorage.setItem('userId', userId);
            localStorage.setItem('username', username);
            setAuthenticated(true);
        } else {
            setUserData({});
            // Clear login state from localStorage
            localStorage.removeItem('authToken');
            localStorage.removeItem('userId');
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