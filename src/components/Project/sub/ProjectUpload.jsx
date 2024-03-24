import React, { useEffect, useState, useRef } from 'react';

import { useNavigate, useParams } from 'react-router-dom';
import useSocket from 'utils/SocketProvider';

import { S3Client, GetObjectCommand, ListObjectsCommand } from "@aws-sdk/client-s3";

const ProjectUpload = ({ props }) => {
    const {
        stage,
        setStage,
        page,
        setPage,
    } = props;

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

    const { projectId } = useParams();
    const navigateTo = useNavigate();

    const s3Downloadv3 = async () => {

        const s3client = new S3Client({
            region: import.meta.env.VITE_AWS_REGION,
            credentials: {
                accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
                secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
            }
        });

        const userId = userData.userId;

        const userImagePath = `user-${userId}/${projectId}/rgb`;

        const listParams = {
            Bucket: import.meta.env.VITE_AWS_BUCKET_NAME,
            Prefix: userImagePath,
        };
        const listData = await s3client.send(new ListObjectsCommand(listParams));

        if (!listData.Contents) {
            console.log("There are no images uploaded in this project.")
            return [];
        }

        const images = await Promise.all(listData.Contents.map(async (file) => {
            const getParams = {
                Bucket: import.meta.env.VITE_AWS_BUCKET_NAME,
                Key: file.Key,
            };
            const getData = await s3client.send(new GetObjectCommand(getParams));

            const bodyStream = getData.Body;
            const bodyAsString = await bodyStream.transformToByteArray();
            const blob = new Blob([bodyAsString.buffer], { type: 'image/jpeg' });
            const fileName = file.Key.split("/").slice(-1)[0];
            const imageFile = new File([blob], fileName, { type: 'image/jpeg' });
            return imageFile;
        }));

        return images;
    }

    const checkIfImageUploaded = async () => {
        try {
            let images = await s3Downloadv3();
            setImages(images);
            setChecked(true);
            setUploaded(true);
            console.log("Images fetched.")
        } catch (error) {
            if (error.name === 'NoSuchKey') {
                console.log("File not found:", error);
                setError(true);
            } else {
                console.log("Error getting file:", error);
            }
        }
    }

    useEffect(() => {
        if (authChecked && authenticated) {
            checkIfImageUploaded();
        }
    }, [authChecked, authenticated]);

    //
    const fileInput = useRef();
    const imageController = useRef();

    let isSubmitting = false;
    const [checked, setChecked] = useState(false);
    const [uploaded, setUploaded] = useState(false);
    const [images, setImages] = useState([]);

    const handleAddImage = (event) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.jpg,.jpeg,.png';
        input.onchange = (event) => {
            const newFiles = Array.from(event.target.files);
            const existingFileNames = images.map(file => file.name);
            const renamedFiles = newFiles.map(newFile => renameFile(newFile, existingFileNames));

            setImages(prevImages => [...prevImages, ...renamedFiles]);
            setUploaded(true);
        };
        input.click();
    }

    const handleRemoveImage = (index) => {
        setImages(prevImages => prevImages.filter((image, i) => i !== index));
    }

    function renameFile(newFile, existingFileNames) {
        let newFileName = newFile.name;

        if (existingFileNames.includes(newFileName)) {
            const fileNameParts = newFileName.split('.');
            const fileExtension = fileNameParts.pop();
            const fileName = fileNameParts.join('.');
            newFileName = `${fileName}_1.${fileExtension}`;
            let count = 2;

            while (existingFileNames.includes(newFileName)) {
                newFileName = `${fileName}_${count}.${fileExtension}`;
                count++;
            }
        }

        return new File([newFile], newFileName, { type: newFile.type });
    }

    const handleDragOver = (event) => {
        event.preventDefault();
    }

    const handleDrop = (event) => {
        event.preventDefault();

        let newImages = [...images];  // Create a copy of the current images
        let existingFileNames = images.map(file => file.name);

        if (event.dataTransfer.items) {
            // Use DataTransferItemList interface to access the file(s)
            for (var i = 0; i < event.dataTransfer.items.length; i++) {
                // If dropped items aren't files, reject them
                if (event.dataTransfer.items[i].kind === 'file') {
                    var file = event.dataTransfer.items[i].getAsFile();
                    var fileType = file.name.split('.').pop().toLowerCase();

                    // Check if file type is jpg, jpeg or png
                    if (fileType === 'jpg' || fileType === 'jpeg' || fileType === 'png') {
                        const renamedFile = renameFile(file, existingFileNames);
                        newImages.push(renamedFile);
                    } else {
                        alert("Invalid file type. Please upload only jpg, jpeg or png files.")
                    }
                }
            }
        } else {
            // Use DataTransfer interface to access the file(s)
            for (var i = 0; i < event.dataTransfer.files.length; i++) {
                var fileType = event.dataTransfer.files[i].name.split('.').pop().toLowerCase();

                // Check if file type is jpg, jpeg or png
                if (fileType === 'jpg' || fileType === 'jpeg' || fileType === 'png') {
                    const renamedFile = renameFile(event.dataTransfer.files[i], existingFileNames);
                    newImages.push(renamedFile);
                } else {
                    alert("Invalid file type. Please upload only jpg, jpeg or png files.")
                }
            }
        }
        setImages(newImages);
        setUploaded(true);
    }

    const handleBeforeUnload = (event) => {
        event.preventDefault();
        event.returnValue = true;
    }

    const gotoNextStage = async () => {
        if (isSubmitting) {
            console.log("Already submitting")
            return;
        }
        if (images.length == 0) {
            alert("Please upload at least one image.\nFor better result, consider at least 8 images from various views.");
            return;
        }
        isSubmitting = true;

        if (imageController.current)
            imageController.current.abort();

        imageController.current = new AbortController();

        const userId = userData.userId;

        const formData = new FormData();
        formData.append('userId', userId);
        formData.append('projectId', projectId);

        images.forEach((image, index) => {
            formData.append('images', image, image.name);
        });

        try {
            const backendURL = import.meta.env.VITE_BACKEND_URL;
            const projectUrl = `${backendURL}/projectUpload`;
            const response = await fetch(projectUrl, {
                method: "POST",
                body: formData,
                signal: imageController.current.signal
            });
            const data = await response.json();
            if (data.status === 200) {
                setStage(2);
            } else {
                alert('Failed to load projects');
            }
        } catch (error) {
            console.log(error);
            isSubmitting = false;
        }
    }

    useEffect(() => {
        if (images.length == 0) {
            setUploaded(false);
        }
    }, [images])

    useEffect(() => {
        if (uploaded)
            window.addEventListener('beforeunload', handleBeforeUnload);
        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
        }
    }, [uploaded])

    // =============================================================

    return (
        <>
            <div id="project-upload" className="project-field">
                <div id="upload-header-wrapper" className='project-header-clean'>
                    <span>Step 1. Upload your images</span>
                    <div id="upload-guide" className="guide" title="View Guideline">?</div>
                </div>

                <div className="upload-form">
                    {!checked && (
                        <div className="upload-wait-field">Preparing storage ...</div>
                    )}
                    {checked && (uploaded ? (
                        <div className="upload-viewer"
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                        >
                            <div className="upload-wrapper">
                                {images.map((image, index) => (
                                    <div className="image-box" key={index}>
                                        <img
                                            src={URL.createObjectURL(image)}
                                            alt={`${image.name}`}
                                            title={`${image.name}`}
                                            className='uploaded-image'
                                        />
                                        <div
                                            onClick={() => handleRemoveImage(index)}
                                            className='remove-image-btn'
                                            title={`Remove ${image.name}`}
                                        >
                                            -
                                        </div>
                                    </div>
                                ))}
                                <div id="upload-extra" className="image-box" onClick={handleAddImage}>
                                    +
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div
                            className='upload-field'
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            onClick={handleAddImage}
                        >
                            <div style={{ textAlign: 'center' }}>
                                Drop images here or click to upload
                                <br />
                                Only jpg, jpeg, png files are supported
                            </div>
                        </div>
                    ))}
                </div>
                <div className="submit-field">
                    {checked && (
                        <div id="next-btn" className="btn buttonFilled" onClick={gotoNextStage} >Next</div>
                    )}
                </div>
            </div>
        </>
    )
};

export default ProjectUpload;